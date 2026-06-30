#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = os.homedir();
const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "xray");
const self = fileURLToPath(import.meta.url);
const beginMarker = "# >>> xray codex telemetry >>>";
const endMarker = "# <<< xray codex telemetry <<<";
const countedOtelEvents = new Set(["codex.websocket_request", "codex.websocket.request"]);
const codexBundleId = "com.openai.codex";
const requestDedupeWindowMs = 1000;

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

  let calls = 0;
  let stopped = false;
  writeState(statePath, calls, "counting");

  const addCalls = (n) => {
    if (!n) return;
    calls += n;
    writeState(statePath, calls, "counting");
  };

  const collector = startOtelCollector({ onCalls: addCalls });
  collector.listen(0, "127.0.0.1", () => {
    let restoreConfig;
    let window;
    try {
      restoreConfig = installCodexTelemetryConfig(collector.address().port, { codexHome });
      relaunchRunningCodexApp();
      window = openWindow(statePath);
      console.log("xray: counting Codex LLM calls live. Press Ctrl-C or close the window to stop.");
    } catch (e) {
      collector.close();
      return exit(`xray failed to start: ${e.message}`);
    }

    const stop = (code = 0) => {
      if (stopped) return;
      stopped = true;
      try { restoreConfig?.(); } catch (e) { console.error(`xray restore warning: ${e.message}`); }
      try { collector.close(); } catch {}
      writeState(statePath, calls, "stopped");
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

function startOtelCollector({ onCalls }) {
  const seenRequests = new Map();
  return http.createServer((req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let calls = 0;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        calls = countOtelCalls(payload, { seenRequests });
      } catch {}
      onCalls(calls);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    req.on("error", () => res.destroy());
  });
}

export function countOtelCalls(payload, { seenRequests = new Map() } = {}) {
  let calls = 0;
  for (const resource of payload?.resourceLogs || []) {
    for (const scope of resource.scopeLogs || []) {
      for (const record of scope.logRecords || []) {
        const attrs = attributesToObject(record.attributes);
        const name = attrs["event.name"];
        if (!countedOtelEvents.has(name)) continue;
        if (seenRecently(record, attrs, seenRequests)) continue;
        calls += 1;
      }
    }
  }
  return calls;
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
  const conversation = attrs["conversation.id"];
  if (!conversation) return null;
  return [
    "codex.websocket_request",
    conversation,
    attrs.model || "",
    attrs.slug || "",
  ].join("|");
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

export function installCodexTelemetryConfig(port, { codexHome = process.env.CODEX_HOME || path.join(home, ".codex") } = {}) {
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });
  const original = readFileIfExists(configPath);
  const mode = fileMode(configPath);
  atomicWrite(configPath, withXrayOtelConfig(original, port), mode);
  return () => atomicWrite(configPath, original, mode);
}

export function withXrayOtelConfig(config, port) {
  const clean = removeTopLevelTables(stripManagedBlock(config), "otel").trimEnd();
  return `${clean}${clean ? "\n\n" : ""}${beginMarker}
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:${port}/v1/logs", protocol = "json" } }
${endMarker}
`;
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

function writeState(file, calls, status) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ label: "codex", calls, status, updated: Date.now() }));
  fs.renameSync(tmp, file);
}

function exit(message, code = 1) {
  if (message) (code ? console.error : console.log)(message);
  process.exit(code);
}
