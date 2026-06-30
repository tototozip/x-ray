#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = os.homedir();
const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "xray");
const self = fileURLToPath(import.meta.url);

const beginMarker = "# >>> xray codex telemetry >>>";
const endMarker = "# <<< xray codex telemetry <<<";
const countedEvents = new Set(["codex.api_request", "codex.websocket.request"]);

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
  if (argv.length) return exit("xray now runs as one global Codex counter: run `xray` with no arguments.");

  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "codex.json");
  let calls = 0;
  writeState(statePath, calls, "starting");

  const metricState = new Map();
  const collector = startOtelCollector({
    onCalls(n) {
      calls += n;
      writeState(statePath, calls, "counting");
    },
    metricState,
  });

  collector.listen(0, "127.0.0.1", () => {
    const { port } = collector.address();
    const endpoint = `http://127.0.0.1:${port}`;
    let restoreConfig;
    let window;
    let stopped = false;

    try {
      restoreConfig = installCodexTelemetryConfig(port);
      writeState(statePath, calls, "counting");
      window = openWindow(statePath);
      console.log("xray: counting Codex LLM calls. Press Ctrl-C or close the window to stop.");
    } catch (e) {
      collector.close();
      return exit(`xray failed to start: ${e.message}`);
    }

    const stop = (code = 0) => {
      if (stopped) return;
      stopped = true;
      writeState(statePath, calls, "stopping");
      try { restoreConfig?.(); } catch (e) { console.error(`xray restore warning: ${e.message}`); }
      try { collector.close(); } catch {}
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

    // Keep the endpoint visible in verbose shells without making it part of
    // the product surface.
    if (process.env.XRAY_DEBUG) console.error(`xray OTLP endpoint: ${endpoint}`);
  });

  collector.on("error", (e) => exit(`xray failed to listen on 127.0.0.1: ${e.message}`));
}

const kill = (p) => { try { p?.kill(); } catch {} };

// ---- Codex OpenTelemetry collector ----

function startOtelCollector({ onCalls, metricState = new Map() }) {
  return http.createServer((req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let calls = 0;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const payload = body ? JSON.parse(body) : {};
        calls = countOtelCalls(payload, { metricState });
      } catch {
        // Codex is configured to send JSON. If that changes, do not break Codex;
        // just accept the export and keep counting from future parseable data.
      }
      if (calls) onCalls(calls);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    req.on("error", () => res.destroy());
  });
}

export function countOtelCalls(payload, { metricState = new Map() } = {}) {
  const logCalls = countLogCalls(payload);
  if (logCalls) return logCalls;
  return countMetricCalls(payload, metricState);
}

function countLogCalls(payload) {
  let calls = 0;
  for (const record of walkLogRecords(payload)) {
    const attrs = attributesToObject(record.attributes);
    const name = attrs["event.name"] || bodyString(record.body);
    if (!countedEvents.has(name)) continue;
    if (name === "codex.api_request" && isNonInferenceApiRequest(attrs, record)) continue;
    calls += 1;
  }
  return calls;
}

function* walkLogRecords(payload) {
  for (const resource of payload?.resourceLogs || []) {
    for (const scope of resource.scopeLogs || []) {
      for (const record of scope.logRecords || []) yield record;
    }
  }
}

function countMetricCalls(payload, metricState) {
  let calls = 0;
  for (const metric of walkMetrics(payload)) {
    if (!["codex.api_request.duration_ms", "codex.websocket.request.duration_ms"].includes(metric.name)) continue;
    const points = metric.histogram?.dataPoints || metric.sum?.dataPoints || [];
    const temporality = metric.histogram?.aggregationTemporality ?? metric.sum?.aggregationTemporality;
    for (const point of points) {
      const attrs = attributesToObject(point.attributes);
      if (metric.name === "codex.api_request.duration_ms" && isNonInferenceApiRequest(attrs, point)) continue;
      const value = Number(point.count ?? point.asInt ?? point.asDouble ?? 0);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (temporality === 1) {
        calls += value;
        continue;
      }
      const key = `${metric.name}:${JSON.stringify(attrs)}:${point.startTimeUnixNano || ""}`;
      const prior = metricState.get(key) || 0;
      metricState.set(key, value);
      calls += value >= prior ? value - prior : value;
    }
  }
  return calls;
}

function* walkMetrics(payload) {
  for (const resource of payload?.resourceMetrics || []) {
    for (const scope of resource.scopeMetrics || []) {
      for (const metric of scope.metrics || []) yield metric;
    }
  }
}

function isNonInferenceApiRequest(attrs, record) {
  const haystack = [
    bodyString(record?.body),
    ...Object.entries(attrs).flatMap(([k, v]) => [k, v]),
  ].map(String).join("\n");
  return /\/models(\?|$|[\s"'])/.test(haystack);
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
  if ("arrayValue" in value) return value.arrayValue?.values?.map(otelValue) || [];
  if ("kvlistValue" in value) return attributesToObject(value.kvlistValue?.values || []);
  return value;
}

function bodyString(body) {
  const v = otelValue(body);
  return typeof v === "string" ? v : "";
}

// ---- Codex config patching ----

export function installCodexTelemetryConfig(port, { codexHome = process.env.CODEX_HOME || path.join(home, ".codex") } = {}) {
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });

  const original = readFileIfExists(configPath);
  const originalMode = fileMode(configPath);
  const next = withXrayOtelConfig(original, port);
  atomicWrite(configPath, next, originalMode);

  return () => restoreCodexTelemetryConfig(configPath, original, originalMode);
}

export function withXrayOtelConfig(config, port) {
  const clean = stripManagedBlock(config);
  const withoutOtel = removeTopLevelTables(clean, "otel").trimEnd();
  const block = buildCodexOtelBlock(port);
  return `${withoutOtel}${withoutOtel ? "\n\n" : ""}${block}\n`;
}

function restoreCodexTelemetryConfig(configPath, original, mode) {
  const current = readFileIfExists(configPath);
  const restored = stripManagedBlock(current).trim();
  const finalContent = original;
  if (!restored && !finalContent) {
    try { fs.unlinkSync(configPath); } catch {}
    return;
  }
  atomicWrite(configPath, finalContent, mode);
}

function buildCodexOtelBlock(port) {
  const base = `http://127.0.0.1:${port}`;
  return `${beginMarker}
[otel]
enabled = true
environment = "xray"
exporter = { otlp-http = { endpoint = "${base}/v1/logs", protocol = "json" } }
metrics_exporter = { otlp-http = { endpoint = "${base}/v1/metrics", protocol = "json" } }
traces_exporter = { otlp-http = { endpoint = "${base}/v1/traces", protocol = "json" } }
${endMarker}`;
}

function stripManagedBlock(config) {
  return config.replace(new RegExp(`\\n?${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, "g"), "\n");
}

function removeTopLevelTables(config, name) {
  const lines = config.split("\n");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    const table = parseTableHeader(line);
    if (table) dropping = table[0] === name;
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
}

function parseTableHeader(line) {
  const m = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
  if (!m) return null;
  return m[1].split(".").map((part) => part.trim().replace(/^"|"$/g, ""));
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

// ---- window ----

function openWindow(statePath) {
  if (process.platform !== "darwin") return null;
  const script = path.join(path.dirname(self), "xray-window.jxa");
  return spawn("osascript", ["-l", "JavaScript", script, statePath], { stdio: "ignore" });
}

function writeState(file, calls, status) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ label: "codex", calls, status, updated: Date.now() }));
  fs.renameSync(tmp, file);
}

function exit(message, code = 1) {
  if (message) (code ? console.error : console.log)(message);
  process.exit(code);
}
