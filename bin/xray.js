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
const countedOtelEvents = new Set(["codex.api_request", "codex.websocket_request", "codex.websocket.request"]);

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
  if (!commandExists("sqlite3")) return exit("xray needs sqlite3 to read Codex's local log database.");

  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "codex.json");
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const dbs = codexLogDbPaths(codexHome);
  const cursors = new Map(dbs.map((db) => [db, readMaxLogId(db)]));
  const seenResponses = new Set();
  const alreadyRunning = baselineCodexPids();

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
    let timer;
    try {
      restoreConfig = installCodexTelemetryConfig(collector.address().port, { codexHome });
      window = openWindow(statePath);
      timer = setInterval(() => {
        let added = 0;
        for (const db of dbs) {
          const result = readNewLogCalls(db, cursors.get(db) || 0, seenResponses, { allowedPids: alreadyRunning });
          cursors.set(db, result.lastId);
          added += result.calls;
        }
        addCalls(added);
      }, 500);
      console.log("xray: counting Codex LLM calls. Press Ctrl-C or close the window to stop.");
    } catch (e) {
      collector.close();
      return exit(`xray failed to start: ${e.message}`);
    }

    const stop = (code = 0) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
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

export function codexLogDbPaths(codexHome) {
  return [
    path.join(codexHome, "logs_2.sqlite"),
    path.join(codexHome, "sqlite", "logs_2.sqlite"),
  ];
}

export function readMaxLogId(dbPath) {
  if (!fs.existsSync(dbPath)) return 0;
  const out = sqlite(dbPath, "select coalesce(max(id), 0) as id from logs;");
  try {
    return Number(JSON.parse(out)[0]?.id || 0);
  } catch {
    return 0;
  }
}

export function readNewLogCalls(dbPath, afterId, seenResponses = new Set(), options = {}) {
  if (!fs.existsSync(dbPath)) return { calls: 0, lastId: afterId };
  const safeAfter = Number.isFinite(Number(afterId)) ? Number(afterId) : 0;
  const sql = `
select id,
  process_uuid,
  case
    when feedback_log_body like 'Received message {"type":"response.created"%'
      or feedback_log_body like 'SSE event: {"type":"response.created"%'
    then feedback_log_body
    else ''
  end as feedback_log_body
from logs
where id > ${safeAfter}
order by id asc
limit 1000;
`;
  const out = sqlite(dbPath, sql);
  let rows = [];
  try {
    rows = JSON.parse(out || "[]");
  } catch {
    return { calls: 0, lastId: safeAfter };
  }
  const counted = countResponseCreatedRows(rows, seenResponses, options);
  const lastId = rows.length ? Number(rows.at(-1).id) : safeAfter;
  return { calls: counted, lastId };
}

export function countResponseCreatedRows(rows, seenResponses = new Set(), { allowedPids = null } = {}) {
  let calls = 0;
  for (const row of rows) {
    if (allowedPids?.size && !processUuidMatchesPid(row.process_uuid, allowedPids)) continue;
    const body = String(row.feedback_log_body || "");
    const responseId = responseCreatedId(body);
    if (!responseId || seenResponses.has(responseId)) continue;
    seenResponses.add(responseId);
    calls += 1;
  }
  return calls;
}

function processUuidMatchesPid(processUuid, pids) {
  const pid = String(processUuid || "").match(/^pid:(\d+):/)?.[1];
  return !!pid && pids.has(pid);
}

export function responseCreatedId(body) {
  if (!/^(?:Received message|SSE event:)\s*\{"type":"response\.created"/.test(body)) return null;
  return body.match(/"response"\s*:\s*\{\s*"id"\s*:\s*"(resp_[^"]+)"/)?.[1] || null;
}

function sqlite(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) return "[]";
  return result.stdout.trim() || "[]";
}

// ---- Codex OpenTelemetry collector for Codex processes started after xray ----

function startOtelCollector({ onCalls }) {
  return http.createServer((req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let calls = 0;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        calls = countOtelCalls(payload);
      } catch {}
      onCalls(calls);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    req.on("error", () => res.destroy());
  });
}

export function countOtelCalls(payload) {
  let calls = 0;
  for (const resource of payload?.resourceLogs || []) {
    for (const scope of resource.scopeLogs || []) {
      for (const record of scope.logRecords || []) {
        const attrs = attributesToObject(record.attributes);
        const name = attrs["event.name"];
        if (!countedOtelEvents.has(name)) continue;
        if (name === "codex.api_request" && isNonInferenceApiRequest(attrs)) continue;
        calls += 1;
      }
    }
  }
  return calls;
}

function isNonInferenceApiRequest(attrs) {
  return Object.values(attrs).some((value) => /\/models(\?|$|[\s"'])/.test(String(value)));
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

export function baselineCodexPids() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
  if (result.status !== 0) return new Set();
  const pids = new Set();
  for (const line of result.stdout.split("\n")) {
    if (!/(^|\/| )codex( |$)|\/Codex(\.app| |\/)/i.test(line)) continue;
    const pid = line.trim().match(/^(\d+)/)?.[1];
    if (pid) pids.add(pid);
  }
  return pids;
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
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
