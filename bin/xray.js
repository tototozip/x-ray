#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = os.homedir();
const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
const xdgState = process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
const self = fileURLToPath(import.meta.url);

const agents = {
  codex: {
    label: "codex",
    roots: [path.join(home, ".codex", "sessions")],
    match: (row) => row?.type === "event_msg" && row?.payload?.type === "token_count",
  },
  claude: {
    label: "claude",
    roots: [path.join(home, ".claude", "projects")],
    match: usageRow,
  },
  openclaw: {
    label: "openclaw",
    roots: [path.join(home, ".openclaw", "agents")],
    match: usageRow,
  },
  pi: {
    label: "pi",
    roots: [path.join(home, ".pi", "agent", "sessions"), path.join(home, ".pi", "agent")],
    match: usageRow,
  },
  pii: null,
  opencode: {
    label: "opencode",
    db: opencodeDb(),
  },
};
agents.pii = agents.pi;

const args = parseArgs(process.argv.slice(2));
const agent = agents[args.agent];
if (!agent) exit(`usage: xray [${Object.keys(agents).join("|")}] [--stdio] [--once] [--path PATH]`);

if (!args.once && !args.stdio && !args.daemon) launchWindow(args);

if (args.daemon) runDaemon(agent, args);
else runCounter(agent, args, render);

function parseArgs(argv) {
  const out = { agent: "codex", once: false, stdio: false, daemon: false, poll: 500, path: "", state: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") out.once = true;
    else if (a === "--stdio") out.stdio = true;
    else if (a === "--daemon") out.daemon = true;
    else if (a === "--path") out.path = argv[++i] || "";
    else if (a === "--state") out.state = argv[++i] || "";
    else if (a === "--poll") out.poll = Number(argv[++i] || out.poll);
    else if (!a.startsWith("-")) out.agent = a;
    else exit(`unknown option: ${a}`);
  }
  return out;
}

function launchWindow(args) {
  if (process.platform !== "darwin") exit("window mode currently requires macOS; use --stdio for terminal mode");
  const state = expand(args.state || path.join(xdgState, "xray", `${args.agent}.json`));
  stopExisting(state);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  writeState(state, args.agent, 0, { ready: false });

  const childArgs = [self, args.agent, "--daemon", "--state", state, "--poll", String(args.poll)];
  if (args.path) childArgs.push("--path", expand(args.path));

  const child = spawn(process.execPath, childArgs, { detached: true, stdio: "ignore" });
  child.unref();
  waitUntilReady(state);
  console.log("xray window opened");
  process.exit(0);
}

function runDaemon(agent, args) {
  const state = expand(args.state || path.join(xdgState, "xray", `${agent.label}.json`));
  fs.mkdirSync(path.dirname(state), { recursive: true });
  const script = path.join(path.dirname(self), "xray-window.jxa");
  const window = spawn("osascript", ["-l", "JavaScript", script, state], { stdio: "ignore" });
  window.on("exit", () => process.exit(0));
  runCounter(agent, args, (label, calls) => writeState(state, label, calls, { ready: true }));
}

function runCounter(agent, args, output) {
  if (agent.db) return watchDb(agent, args, output);
  return watchJsonl(agent, args, output);
}

function watchJsonl(agent, args, output) {
  let calls = 0;
  const seen = new Map();
  const roots = args.path ? [expand(args.path)] : agent.roots;

  scanJsonl(roots, seen, agent.match, { initial: true, all: args.once }, (n) => (calls += n));
  output(agent.label, calls, true);
  if (args.once) return;

  const timer = setInterval(() => {
    scanJsonl(roots, seen, agent.match, { initial: false, all: false }, (n) => {
      if (n) {
        calls += n;
        output(agent.label, calls);
      }
    });
  }, Math.max(100, args.poll || 500));
  process.on("SIGINT", () => {
    clearInterval(timer);
    if (process.stdout.isTTY) process.stdout.write("\n");
  });
}

function watchDb(agent, args, output) {
  const db = expand(args.path || agent.db);
  const baseline = args.once ? 0 : queryOpencode(db);
  let calls = Math.max(0, queryOpencode(db) - baseline);
  output(agent.label, calls, true);
  if (args.once) return;

  const timer = setInterval(() => {
    const next = Math.max(0, queryOpencode(db) - baseline);
    if (next !== calls) {
      calls = next;
      output(agent.label, calls);
    }
  }, Math.max(500, args.poll || 1000));
  process.on("SIGINT", () => {
    clearInterval(timer);
    if (process.stdout.isTTY) process.stdout.write("\n");
  });
}

function scanJsonl(roots, seen, match, opts, add) {
  for (const file of listJsonl(roots)) {
    const stat = safeStat(file);
    if (!stat) continue;
    const previous = seen.get(file);
    const start = opts.all ? 0 : previous === undefined ? (opts.initial ? stat.size : 0) : Math.min(previous, stat.size);
    if (start >= stat.size) {
      seen.set(file, stat.size);
      continue;
    }
    const result = countJsonl(file, start, match, opts.all);
    seen.set(file, result.offset);
    add(result.count);
  }
}

function countJsonl(file, start, match, includeTrailing = false) {
  const text = fs.readFileSync(file).subarray(start).toString("utf8");
  const lastNewline = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  const completeText = includeTrailing || lastNewline === text.length - 1 ? text : text.slice(0, lastNewline + 1);
  let count = 0;
  for (const line of completeText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      if (match(JSON.parse(line))) count++;
    } catch {}
  }
  return { count, offset: start + Buffer.byteLength(completeText) };
}

function listJsonl(roots) {
  const out = [];
  for (const root of roots) collect(root, out);
  return out;
}

function collect(target, out) {
  const stat = safeStat(target);
  if (!stat) return;
  if (stat.isFile() && target.endsWith(".jsonl")) return out.push(target);
  if (!stat.isDirectory()) return;
  for (const entry of safeReaddir(target)) collect(path.join(target, entry.name), out);
}

function usageRow(row) {
  return hasUsage(row?.message) || hasUsage(row);
}

function hasUsage(message) {
  if (message?.role !== "assistant") return false;
  const usage = message.usage || message.tokens;
  return usage ? usageTotal(usage) > 0 : false;
}

function usageTotal(usage) {
  const flat = [
    "totalTokens",
    "total_tokens",
    "input",
    "output",
    "input_tokens",
    "output_tokens",
    "reasoning",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];
  return flat.reduce((sum, key) => sum + number(usage[key]), 0) + number(usage.cache?.read) + number(usage.cache?.write);
}

function queryOpencode(db) {
  if (!fs.existsSync(db)) return 0;
  const sql = "select count(*) from event where type='session.next.step.ended';";
  const result = spawnSync("sqlite3", ["-readonly", db, sql], { encoding: "utf8" });
  if (result.status !== 0) return 0;
  return Number(result.stdout.trim()) || 0;
}

function opencodeDb() {
  const env = process.env.OPENCODE_DB;
  if (env) return path.isAbsolute(env) || env === ":memory:" ? env : path.join(xdgData, "opencode", env);
  return path.join(xdgData, "opencode", "opencode.db");
}

function render(label, calls, first = false) {
  const line = `${label} llm calls: ${calls}`;
  if (!process.stdout.isTTY) return (first || calls > 0) && console.log(line);
  process.stdout.write(`\r${line}`);
}

function writeState(file, label, calls, extra = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ label, calls, updated: Date.now(), ...extra }));
  fs.renameSync(tmp, file);
}

function waitUntilReady(file) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).ready) return;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function stopExisting(state) {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (ps.status !== 0) return;
  for (const line of ps.stdout.split("\n")) {
    if (!line.includes(state) || !line.includes("xray")) continue;
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (!pid || pid === process.pid || pid === process.ppid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function expand(p) {
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : path.resolve(p);
}

function number(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function exit(message) {
  console.error(message);
  process.exit(1);
}
