import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const riskyPattern = /\b(git|chmod|kill|pkill|osascript|curl|sqlite3)\b|\brm\s+|\brm\s+-rf\b|\bapply_patch\b|\bnpm\s+install\b/i;

const interceptedHosts = new Set(["api.anthropic.com", "api.openai.com"]);

export function textIsRisky(text) {
  return riskyPattern.test(String(text || ""));
}

export function scanProviderResponseChunk(provider, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  if (!textIsRisky(text)) return false;
  if (provider === "anthropic") return text.includes("content_block_delta") || text.includes("message_delta") || text.includes("message_start");
  if (provider === "openai") return text.includes("response.") || text.includes("data:");
  return true;
}

export function startRiskProxy({ onRisky, workDir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-proxy-")) } = {}) {
  const certs = ensureCertificates(workDir);
  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(certs.leafKey),
      cert: fs.readFileSync(certs.leafCert),
      ALPNProtocols: ["http/1.1"],
    },
    (req, res) => forwardInterceptedRequest(req, res, { onRisky }),
  );
  httpsServer.on("tlsClientError", () => {});

  const proxyServer = net.createServer((client) => handleProxyConnection(client, httpsServer));
  proxyServer.on("error", () => {});

  return {
    caCert: certs.caCert,
    proxyServer,
    httpsServer,
    workDir,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        httpsServer.listen(0, host, () => {
          proxyServer.listen(port, host, resolve);
        });
        httpsServer.once("error", reject);
        proxyServer.once("error", reject);
      });
    },
    address() {
      return proxyServer.address();
    },
    close() {
      try { proxyServer.close(); } catch {}
      try { httpsServer.close(); } catch {}
    },
    cleanup() {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    },
  };
}

function ensureCertificates(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caKey = path.join(dir, "ca-key.pem");
  const caCert = path.join(dir, "ca-cert.pem");
  const leafKey = path.join(dir, "leaf-key.pem");
  const leafCsr = path.join(dir, "leaf.csr");
  const leafCert = path.join(dir, "leaf-cert.pem");
  const leafExt = path.join(dir, "leaf.ext");

  runOpenSsl(["genrsa", "-out", caKey, "2048"]);
  runOpenSsl(["req", "-x509", "-new", "-nodes", "-key", caKey, "-sha256", "-days", "1", "-subj", "/CN=xray-temporary-ca", "-out", caCert]);
  runOpenSsl(["genrsa", "-out", leafKey, "2048"]);
  runOpenSsl(["req", "-new", "-key", leafKey, "-subj", "/CN=api.anthropic.com", "-out", leafCsr]);
  fs.writeFileSync(leafExt, [
    "subjectAltName=DNS:api.anthropic.com,DNS:api.openai.com",
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n"));
  runOpenSsl(["x509", "-req", "-in", leafCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", leafCert, "-days", "1", "-sha256", "-extfile", leafExt]);

  return { caCert, leafKey, leafCert };
}

function runOpenSsl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || `openssl ${args.join(" ")} failed`).trim());
  }
}

function handleProxyConnection(client, httpsServer) {
  client.on("error", () => {});
  let header = Buffer.alloc(0);
  const onData = (chunk) => {
    header = Buffer.concat([header, chunk]);
    const text = header.toString("utf8");
    const end = text.indexOf("\r\n\r\n");
    if (end < 0) return;
    client.off("data", onData);

    const firstLine = text.slice(0, end).split("\r\n")[0];
    const match = firstLine.match(/^CONNECT\s+([^:]+):(\d+)\s+HTTP/i);
    if (!match) {
      client.end("HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    const host = match[1];
    const port = Number(match[2]);
    const localMitm = interceptedHosts.has(host) && port === 443;
    const upstream = localMitm ? net.connect(httpsServer.address().port, "127.0.0.1") : net.connect(port, host);
    upstream.on("error", () => client.destroy());
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = header.subarray(end + 4);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  };
  client.on("data", onData);
}

function forwardInterceptedRequest(req, res, { onRisky }) {
  const provider = req.headers.host?.includes("anthropic") ? "anthropic" : "openai";
  const requestChunks = [];
  req.on("data", (chunk) => requestChunks.push(chunk));
  req.on("end", () => {
    const requestBody = Buffer.concat(requestChunks);
    const headers = { ...req.headers, host: provider === "anthropic" ? "api.anthropic.com" : "api.openai.com" };
    delete headers["proxy-connection"];
    headers["accept-encoding"] = "identity";

    const upstream = https.request(
      {
        hostname: headers.host,
        port: 443,
        method: req.method,
        path: req.url,
        headers,
        ALPNProtocols: ["http/1.1"],
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        let marked = false;
        let scanWindow = "";
        upRes.on("data", (chunk) => {
          scanWindow = (scanWindow + chunk.toString("utf8")).slice(-4096);
          if (!marked && scanProviderResponseChunk(provider, scanWindow)) {
            marked = true;
            onRisky?.({ provider });
          }
          res.write(chunk);
        });
        upRes.on("end", () => res.end());
      },
    );
    upstream.on("error", (e) => {
      try {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(e.message || e));
      } catch {}
    });
    upstream.end(requestBody);
  });
}
