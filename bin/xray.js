#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = os.homedir();
const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "xray");
const certDir = path.join(stateDir, "certs");
const self = fileURLToPath(import.meta.url);

// LLM API hosts to intercept. Inference requests to these are counted; all
// other traffic is tunneled through untouched.
const HOSTS = ["api.openai.com", "api.anthropic.com", "chatgpt.com"];
const AGENTS = { codex: "codex", claude: "claude" };

// One inference call == one POST to a model endpoint.
export const isCall = (method, p) =>
  method === "POST" && /\/(responses|chat\/completions|messages)(\?|$)/.test(p);

if (process.argv[1] === self) main();

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    return exit("usage: xray [agent|command...]\n  xray         count every LLM call in a fresh shell\n  xray codex   count a single agent", 0);
  }
  // With no arguments, wrap an interactive shell so every agent run inside it
  // is counted; otherwise wrap the given agent/command directly.
  const wrap = argv.length ? argv : [process.env.SHELL || "/bin/zsh", "-i"];
  const command = AGENTS[wrap[0]] || wrap[0];
  const label = AGENTS[wrap[0]] ? wrap[0] : "";
  const certs = ensureCerts();
  const statePath = path.join(stateDir, `${label || "session"}.json`);
  writeState(statePath, label, 0);

  let calls = 0;
  const proxy = startProxy(certs, () => writeState(statePath, label, ++calls));
  proxy.listen(0, "127.0.0.1", () => {
    const { port } = proxy.address();
    const window = openWindow(statePath);
    const child = spawn(command, wrap.slice(1), { stdio: "inherit", env: childEnv(port, certs) });
    process.on("SIGINT", () => {}); // the agent owns Ctrl-C; we exit when it does
    process.on("exit", () => { kill(child); kill(window); }); // never leak the agent or window
    child.on("error", (e) => exit(`failed to launch ${command}: ${e.message}`));
    child.on("exit", (code) => process.exit(code ?? 0));
  });
}

const kill = (p) => { try { p?.kill(); } catch {} };

function childEnv(port, certs) {
  const url = `http://127.0.0.1:${port}`;
  return {
    ...process.env,
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
    http_proxy: url, https_proxy: url, all_proxy: url,
    NODE_EXTRA_CA_CERTS: certs.ca, // Node adds this to its defaults
    SSL_CERT_FILE: certs.bundle, // Rust/OpenSSL replace defaults, so use the merged bundle
  };
}

// ---- counting proxy ----

function startProxy(certs, onCall) {
  const key = fs.readFileSync(certs.leafKey);
  const cert = fs.readFileSync(certs.leafCert);
  const intercept = new Set(HOSTS);

  const inner = http.createServer((creq, cres) => {
    const host = (creq.headers.host || "").split(":")[0];
    if (isCall(creq.method, creq.url)) onCall();
    const up = https.request(
      { host, port: 443, method: creq.method, path: creq.url, headers: creq.headers },
      (ures) => {
        cres.writeHead(ures.statusCode, ures.headers);
        ures.pipe(cres);
      },
    );
    up.on("error", () => cres.destroy());
    creq.pipe(up);
  });
  // Refuse websocket upgrades so the agent falls back to the countable HTTPS path.
  inner.on("upgrade", (_req, sock) => {
    sock.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  const tlsServer = tls.createServer({ key, cert, ALPNProtocols: ["http/1.1"] }, (s) =>
    inner.emit("connection", s),
  );

  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, client, head) => {
    const [host, port] = req.url.split(":");
    if (intercept.has(host)) {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) client.unshift(head);
      tlsServer.emit("connection", client);
    } else {
      const up = net.connect(Number(port) || 443, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) up.write(head);
        client.pipe(up);
        up.pipe(client);
      });
      up.on("error", () => client.destroy());
      client.on("error", () => up.destroy());
    }
  });
  return proxy;
}

// ---- window ----

function openWindow(statePath) {
  if (process.platform !== "darwin") return null;
  const script = path.join(path.dirname(self), "xray-window.jxa");
  return spawn("osascript", ["-l", "JavaScript", script, statePath], { stdio: "ignore" });
}

// ---- certificates ----

// A local CA + one leaf covering the intercepted hosts, plus a bundle that
// merges the system roots with our CA (for TLS stacks that replace, not extend).
export function ensureCerts() {
  fs.mkdirSync(certDir, { recursive: true });
  const ca = path.join(certDir, "ca-cert.pem");
  const caKey = path.join(certDir, "ca-key.pem");
  const leafCert = path.join(certDir, "leaf-cert.pem");
  const leafKey = path.join(certDir, "leaf-key.pem");
  const bundle = path.join(certDir, "bundle.pem");

  if (!fs.existsSync(ca)) {
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca,
      "-days", "3650", "-subj", "/CN=x-ray local CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  }
  if (!fs.existsSync(leafCert)) {
    const csr = path.join(certDir, "leaf.csr");
    const ext = path.join(certDir, "leaf.ext");
    fs.writeFileSync(ext, `basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(",")}
`);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", leafKey, "-out", csr, "-subj", "/CN=x-ray"]);
    openssl(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial",
      "-out", leafCert, "-days", "3650", "-extfile", ext]);
  }
  if (!fs.existsSync(bundle) || mtime(ca) > mtime(bundle)) {
    const roots = spawnSync("security", ["find-certificate", "-a", "-p",
      "/System/Library/Keychains/SystemRootCertificates.keychain"], { encoding: "utf8" }).stdout || "";
    fs.writeFileSync(bundle, roots + fs.readFileSync(ca, "utf8"));
  }
  return { ca, leafKey, leafCert, bundle };
}

function openssl(args) {
  const r = spawnSync("openssl", args, { encoding: "utf8" });
  if (r.status !== 0) exit(`openssl failed: ${r.stderr || r.error?.message || "unknown"}`);
}

// ---- state file (read by xray-window.jxa) ----

function writeState(file, label, calls) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ label, calls, updated: Date.now() }));
  fs.renameSync(tmp, file);
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function exit(message, code = 1) {
  if (message) (code ? console.error : console.log)(message);
  process.exit(code);
}
