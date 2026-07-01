import fs from "node:fs";
import http from "node:http";
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
  return sseEvents(text).some((event) => scanProviderResponseEvent(provider, event));
}

export function scanProviderResponseEvent(provider, event) {
  const data = eventData(event);
  if (!data || data === "[DONE]") return false;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }

  if (provider === "anthropic") {
    return [
      parsed.delta?.text,
      parsed.delta?.partial_json,
      parsed.content_block?.text,
      parsed.content_block?.input,
    ].some(textIsRisky);
  }

  if (provider === "openai") {
    return [
      parsed.delta,
      parsed.arguments,
      parsed.item?.arguments,
      parsed.item?.input,
      ...(parsed.response?.output || []).flatMap((item) => [
        item.arguments,
        item.input,
        ...(item.content || []).map((content) => content.text),
      ]),
    ].some(textIsRisky);
  }

  return false;
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
  const openaiReverseServer = http.createServer((req, res) => forwardProviderRequest(req, res, { provider: "openai", onRisky }));
  openaiReverseServer.on("upgrade", (req, socket) => {
    debugProxy(`openai reverse upgrade ${req.url}`);
    socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
  });
  openaiReverseServer.on("error", () => {});

  return {
    caCert: certs.caCert,
    proxyServer,
    httpsServer,
    openaiReverseServer,
    workDir,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        httpsServer.listen(0, host, () => {
          proxyServer.listen(port, host, () => {
            openaiReverseServer.listen(0, host, resolve);
          });
        });
        httpsServer.once("error", reject);
        proxyServer.once("error", reject);
        openaiReverseServer.once("error", reject);
      });
    },
    address() {
      return proxyServer.address();
    },
    openaiBaseUrl() {
      return `http://127.0.0.1:${openaiReverseServer.address().port}/v1`;
    },
    close() {
      try { proxyServer.close(); } catch {}
      try { httpsServer.close(); } catch {}
      try { openaiReverseServer.close(); } catch {}
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
  return forwardProviderRequest(req, res, { provider, onRisky });
}

function forwardProviderRequest(req, res, { provider, onRisky }) {
  debugProxy(`${provider} ${req.method} ${req.url}`);
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
        let scanBuffer = "";
        upRes.on("data", (chunk) => {
          scanBuffer += chunk.toString("utf8");
          const parts = scanBuffer.split(/\r?\n\r?\n/);
          scanBuffer = parts.pop() || "";
          for (const part of parts) {
            if (!marked && scanProviderResponseEvent(provider, part)) {
              marked = true;
              debugProxy(`${provider} risky response ${req.url}`);
              onRisky?.({ provider });
              break;
            }
          }
          res.write(chunk);
        });
        upRes.on("end", () => res.end());
      },
    );
    upstream.on("error", (e) => {
      debugProxy(`${provider} upstream error ${e.message || e}`);
      try {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(e.message || e));
      } catch {}
    });
    upstream.end(requestBody);
  });
}

function debugProxy(message) {
  if (process.env.XRAY_PROXY_DEBUG === "1") console.error(`xray proxy: ${message}`);
}

function sseEvents(text) {
  return String(text || "").split(/\r?\n\r?\n/).filter(Boolean);
}

function eventData(event) {
  return String(event || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}
