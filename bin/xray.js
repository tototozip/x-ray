#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startRiskProxy } from "./xray-proxy.js";

const home = os.homedir();
const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "xray");
const self = fileURLToPath(import.meta.url);
const beginMarker = "# >>> xray codex telemetry >>>";
const endMarker = "# <<< xray codex telemetry <<<";
const claudeBeginMarker = "__xray_claude_telemetry_begin__";
const claudeEndMarker = "__xray_claude_telemetry_end__";
const websocketRequestEvents = new Set(["codex.websocket_request", "codex.websocket.request"]);
const codexBundleId = "com.openai.codex";
const requestDedupeWindowMs = 1000;
const claudeTelemetryEnvKeys = [
  claudeBeginMarker,
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_TRACES_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  claudeEndMarker,
];

if (isMain()) main();

function isMain() {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === self;
  } catch {
    return false;
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    return exit("usage: xray\n\nCounts Codex LLM calls until you press Ctrl-C or close the window.", 0);
  }
  if (argv.length) return exit("xray runs as one Codex counter: run `xray` with no arguments.");

  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "codex.json");
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");

  let calls = 0;
  const models = {};
  const providers = {};
  const riskyModels = {};
  const riskyActions = {};
  let risky = 0;
  let stopped = false;
  writeState(statePath, { calls, risky, status: "counting", models, providers, riskyModels, riskyActions });

  const addRisky = ({ provider = "unknown", model = "unknown", action = "unknown" } = {}) => {
    risky += 1;
    const actionName = String(action || "unknown").trim() || "unknown";
    if (model !== "unknown") riskyModels[model] = (riskyModels[model] || 0) + 1;
    riskyActions[actionName] = (riskyActions[actionName] || 0) + 1;
    writeState(statePath, { calls, risky, status: "counting", models, providers, riskyModels, riskyActions });
  };

  const addRequests = (requests) => {
    if (!requests.length) return;
    calls += requests.length;
    for (const request of requests) {
      models[request.model] = (models[request.model] || 0) + 1;
      providers[request.model] = request.provider;
    }
    writeState(statePath, { calls, risky, status: "counting", models, providers, riskyModels, riskyActions });
  };

  const collector = startOtelCollector({ onRequests: addRequests });
  collector.listen(0, "127.0.0.1", async () => {
    let restoreConfig;
    let window;
    let riskProxy;
    try {
      const port = collector.address().port;
      riskProxy = startRiskProxy({ onRisky: addRisky, workDir: path.join(stateDir, `proxy-${process.pid}`) });
      await riskProxy.listen();
      const proxyPort = riskProxy.address().port;
      const proxyEnv = riskProxyEnv(proxyPort, riskProxy.caCert);
      const restoreCodexConfig = installCodexTelemetryConfig(port, { codexHome, openaiBaseUrl: riskProxy.openaiBaseUrl() });
      const restoreClaudeConfig = installClaudeTelemetryConfig(port, { claudeHome, proxyEnv });
      restoreConfig = () => {
        restoreCodexConfig();
        restoreClaudeConfig();
      };
      relaunchRunningCodexApp();
      window = openWindow(statePath);
      console.log("xray: counting Codex and Claude Code LLM calls live. Press Ctrl-C or close the window to stop.");
    } catch (e) {
      collector.close();
      return exit(`xray failed to start: ${e.message}`);
    }

    const stop = (code = 0) => {
      if (stopped) return;
      stopped = true;
      try { restoreConfig?.(); } catch (e) { console.error(`xray restore warning: ${e.message}`); }
      try { riskProxy?.close(); } catch {}
      try { riskProxy?.cleanup(); } catch {}
      try { collector.close(); } catch {}
      writeState(statePath, { calls, risky, status: "stopped", models, providers, riskyModels, riskyActions });
      kill(window);
      process.exit(code);
    };

    process.on("SIGINT", () => stop(0));
    for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => stop(0));
    process.on("exit", () => {
      if (!stopped) {
        try { restoreConfig?.(); } catch {}
      }
    });
    window?.on("exit", () => stop(0));
    process.stdin.resume();
  });
  collector.on("error", (e) => exit(`xray failed to listen on 127.0.0.1: ${e.message}`));
}

const kill = (p) => { try { p?.kill(); } catch {} };

// ---- Codex OpenTelemetry collector ----

function startOtelCollector({ onRequests }) {
  const seenRequests = new Map();
  return http.createServer((req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let requests = [];
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        requests = collectOtelRequests(payload, { seenRequests });
      } catch {}
      onRequests(requests);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    req.on("error", () => res.destroy());
  });
}

export function countOtelCalls(payload, { seenRequests = new Map() } = {}) {
  return collectOtelRequests(payload, { seenRequests }).length;
}

export function collectOtelRequests(payload, { seenRequests = new Map() } = {}) {
  const requests = [];
  for (const resource of payload?.resourceLogs || []) {
    for (const scope of resource.scopeLogs || []) {
      for (const record of scope.logRecords || []) {
        const attrs = attributesToObject(record.attributes);
        const name = attrs["event.name"];
        const body = otelValue(record.body);
        if (!isLlmRequestEvent(name, attrs, body)) continue;
        if (seenRecently(record, attrs, seenRequests)) continue;
        requests.push({ model: requestModel(attrs), provider: requestProvider(name, body) });
      }
    }
  }
  return requests;
}

function requestModel(attrs) {
  return String(attrs.model || attrs.slug || attrs["model.name"] || attrs["llm.model"] || "unknown").trim() || "unknown";
}

function requestProvider(name, body) {
  if (body === "claude_code.api_request" || name === "api_request") return "claude";
  return "codex";
}

function isLlmRequestEvent(name, attrs, body) {
  if (websocketRequestEvents.has(name)) return true;
  if (body === "claude_code.api_request") return true;
  if (name === "api_request" && attrs.request_id && attrs.model) return true;
  if (name === "codex.api_request") return isInferenceApiRequest(attrs);
  return false;
}

function isInferenceApiRequest(attrs) {
  return endpointKind(attrs) !== null;
}

function seenRecently(record, attrs, seenRequests) {
  const key = requestKey(attrs);
  if (!key) return false;

  const timestamp = requestTimestamp(record, attrs);
  for (const [seenKey, seenAt] of seenRequests) {
    if (timestamp - seenAt > requestDedupeWindowMs) seenRequests.delete(seenKey);
  }

  const previous = seenRequests.get(key);
  seenRequests.set(key, timestamp);
  return previous !== undefined && Math.abs(timestamp - previous) <= requestDedupeWindowMs;
}

function requestKey(attrs) {
  if (attrs.request_id) return ["claude.llm_request", attrs.request_id].join("|");

  const conversation = attrs["conversation.id"];
  if (!conversation) return null;
  return [
    "codex.llm_request",
    conversation,
    endpointKind(attrs) || "responses",
    attrs.model || "",
    attrs.slug || "",
  ].join("|");
}

function endpointKind(attrs) {
  const candidates = [
    attrs.endpoint,
    attrs["api.path"],
    attrs["http.route"],
    attrs["http.target"],
    attrs["url.path"],
    attrs.path,
    attrs.url,
    attrs["http.url"],
  ];
  for (const value of candidates) {
    const kind = endpointKindFromValue(value);
    if (kind) return kind;
  }
  return null;
}

function endpointKindFromValue(value) {
  if (value == null) return null;
  let text = String(value).trim().toLowerCase();
  if (!text) return null;
  try {
    text = new URL(text).pathname;
  } catch {}
  text = text.split("?", 1)[0].replace(/^\/+/, "");
  if (text.startsWith("v1/")) text = text.slice(3);
  if (text === "responses" || text.startsWith("responses/")) return "responses";
  if (text === "chat/completions" || text.startsWith("chat/completions/")) return "chat_completions";
  return null;
}

function requestTimestamp(record, attrs) {
  const eventMs = Date.parse(attrs["event.timestamp"] || "");
  if (Number.isFinite(eventMs)) return eventMs;

  const observed = Number(record.observedTimeUnixNano || record.timeUnixNano || 0);
  if (Number.isFinite(observed) && observed > 0) return Math.round(observed / 1_000_000);

  return Date.now();
}

function attributesToObject(attrs = []) {
  const out = {};
  for (const attr of attrs) out[attr.key] = otelValue(attr.value);
  return out;
}

function otelValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return value.intValue;
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  return value;
}

// ---- Temporary Codex config for future Codex processes ----

export function installCodexTelemetryConfig(port, { codexHome = process.env.CODEX_HOME || path.join(home, ".codex"), openaiBaseUrl = null } = {}) {
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });
  const original = readFileIfExists(configPath);
  const mode = fileMode(configPath);
  atomicWrite(configPath, withXrayOtelConfig(original, port, openaiBaseUrl), mode);
  return () => atomicWrite(configPath, original, mode);
}

export function installClaudeTelemetryConfig(port, { claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), proxyEnv = null } = {}) {
  const settingsPath = path.join(claudeHome, "settings.json");
  fs.mkdirSync(claudeHome, { recursive: true });
  const original = readFileIfExists(settingsPath);
  const mode = fileMode(settingsPath);
  atomicWrite(settingsPath, withXrayClaudeSettings(original, port, proxyEnv), mode);
  return () => atomicWrite(settingsPath, original, mode);
}

export function withXrayOtelConfig(config, port, openaiBaseUrl = null) {
  const clean = removeTopLevelKeys(removeTopLevelTables(stripManagedBlock(config), "otel"), ["openai_base_url"]).trimEnd();
  const proxyLine = openaiBaseUrl ? `openai_base_url = ${JSON.stringify(openaiBaseUrl)}\n` : "";
  return `${beginMarker}
${proxyLine}
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:${port}/v1/logs", protocol = "json" } }
${endMarker}
${clean ? `\n${clean}\n` : ""}
`;
}

export function withXrayClaudeSettings(settings, port, proxyEnv = null) {
  let parsed = {};
  try {
    parsed = settings.trim() ? JSON.parse(settings) : {};
  } catch {
    parsed = {};
  }
  const env = { ...(parsed.env && typeof parsed.env === "object" ? parsed.env : {}) };
  for (const key of claudeTelemetryEnvKeys) delete env[key];
  parsed.env = {
    ...env,
    [claudeBeginMarker]: "managed by xray; removed on exit",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
    OTEL_LOGS_EXPORT_INTERVAL: "500",
    ...(proxyEnv || {}),
    [claudeEndMarker]: "managed by xray; removed on exit",
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function riskProxyEnv(port, caCert) {
  const proxy = `http://127.0.0.1:${port}`;
  return {
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    NODE_EXTRA_CA_CERTS: caCert,
  };
}

function stripManagedBlock(config) {
  return config.replace(new RegExp(`\\n?${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, "g"), "\n");
}

function removeTopLevelTables(config, name) {
  const kept = [];
  let dropping = false;
  for (const line of config.split("\n")) {
    const table = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/)?.[1]?.split(".")[0]?.replace(/^"|"$/g, "");
    if (table) dropping = table === name;
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
}

function removeTopLevelKeys(config, names) {
  const drop = new Set(names);
  const kept = [];
  let inTopLevel = true;
  for (const line of config.split("\n")) {
    if (/^\s*\[/.test(line)) inTopLevel = false;
    const key = inTopLevel ? line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1] : null;
    if (key && drop.has(key)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function readFileIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function fileMode(file) {
  try { return fs.statSync(file).mode & 0o777; } catch { return 0o600; }
}

function atomicWrite(file, content, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch {}
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function relaunchRunningCodexApp({
  shouldRelaunch = process.env.XRAY_RELAUNCH_CODEX_APP !== "0",
  platform = process.platform,
  isRunning = codexAppIsRunning,
  runCommand = run,
  wait = waitUntil,
  log = console.log,
} = {}) {
  if (!shouldRelaunch || platform !== "darwin" || !isRunning()) return false;

  log("xray: relaunching Codex app once so it picks up live counting.");
  runCommand("osascript", ["-e", `tell application id "${codexBundleId}" to quit`]);
  if (!wait(() => !isRunning(), 8000)) {
    runCommand("pkill", ["-TERM", "-x", "Codex"]);
    if (!wait(() => !isRunning(), 5000)) {
      throw new Error("Codex app did not quit; stop Codex and run xray again.");
    }
  }
  runCommand("open", ["-b", codexBundleId]);
  return true;
}

export function codexAppIsRunning() {
  const result = spawnSync("osascript", ["-e", `application id "${codexBundleId}" is running`], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function waitUntil(done, timeoutMs) {
  const start = Date.now();
  while (!done() && Date.now() - start < timeoutMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return done();
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || `${command} failed`).trim());
  }
  return result.stdout;
}

function openWindow(statePath) {
  if (process.platform !== "darwin") return null;
  const script = path.join(path.dirname(self), "xray-window.jxa");
  return spawn("osascript", ["-l", "JavaScript", script, statePath], { stdio: "ignore" });
}

function writeState(file, { calls, risky = 0, status, models = {}, providers = {}, riskyModels = {}, riskyActions = {} }) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ label: "xray", calls, risky, models, providers, riskyModels, riskyActions, status, updated: Date.now() }));
  fs.renameSync(tmp, file);
}

function exit(message, code = 1) {
  if (message) (code ? console.error : console.log)(message);
  process.exit(code);
}
