#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const home = os.homedir();
const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");

const agents = {
  codex: {
    label: "codex",
    roots: [path.join(home, ".codex", "sessions")],
    match: (o) => o?.type === "event_msg" && o?.payload?.type === "token_count",
  },
  openclaw: {
    label: "openclaw",
    roots: [path.join(home, ".openclaw", "agents")],
    match: (o) => isAssistantUsage(o?.message) || isAssistantUsage(o),
  },
  pi: {
    label: "pi",
    roots: [path.join(home, ".pi", "agent", "sessions"), path.join(home, ".pi", "agent")],
    match: (o) => isAssistantUsage(o?.message) || isAssistantUsage(o),
  },
  pii: null,
  opencode: {
    label: "opencode",
    sqlite: opencodeDb(),
  },
};
agents.pii = agents.pi;

const args = parseArgs(process.argv.slice(2));
const agent = agents[args.agent];
if (!agent) exit(`usage: xray [${Object.keys(agents).join("|")}] [--once] [--total] [--path PATH]`);

if (agent.sqlite) watchSqlite(agent, args);
else watchJsonl(agent, args);

function parseArgs(argv) {
  const out = { agent: "codex", once: false, total: false, poll: 500, path: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") out.once = true;
    else if (a === "--total") out.total = true;
    else if (a === "--path") out.path = argv[++i] || "";
    else if (a === "--poll") out.poll = Number(argv[++i] || out.poll);
    else if (!a.startsWith("-")) out.agent = a;
    else exit(`unknown option: ${a}`);
  }
  return out;
}

function watchJsonl(agent, args) {
  let calls = 0;
  const seen = new Map();
  const roots = args.path ? [expand(args.path)] : agent.roots;

  scan(roots, seen, agent.match, args.once || args.total ? "all" : "end", (n) => (calls += n));
  render(agent.label, calls, true);
  if (args.once) return finish();

  const timer = setInterval(() => {
    scan(roots, seen, agent.match, "new", (n) => {
      if (n) {
        calls += n;
        render(agent.label, calls);
      }
    });
  }, Math.max(100, args.poll || 500));
  process.on("SIGINT", () => {
    clearInterval(timer);
    finish();
  });
}

function watchSqlite(agent, args) {
  const db = expand(args.path || agent.sqlite);
  const baseline = args.total || args.once ? 0 : queryOpencode(db);
  let calls = Math.max(0, queryOpencode(db) - baseline);
  render(agent.label, calls, true);
  if (args.once) return finish();

  const timer = setInterval(() => {
    const next = Math.max(0, queryOpencode(db) - baseline);
    if (next !== calls) {
      calls = next;
      render(agent.label, calls);
    }
  }, Math.max(500, args.poll || 1000));
  process.on("SIGINT", () => {
    clearInterval(timer);
    finish();
  });
}

function scan(roots, seen, match, mode, add) {
  for (const file of listJsonl(roots)) {
    const stat = safeStat(file);
    if (!stat) continue;
    const previous = seen.get(file);
    const start = mode === "all" ? 0 : mode === "end" ? stat.size : previous === undefined ? 0 : Math.min(previous, stat.size);
    seen.set(file, stat.size);
    if (start >= stat.size) continue;
    add(countFile(file, start, match));
  }
}

function countFile(file, start, match) {
  const text = fs.readFileSync(file, "utf8").slice(start);
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      if (match(JSON.parse(line))) count++;
    } catch {}
  }
  return count;
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

function isAssistantUsage(message) {
  if (!message || message.role !== "assistant") return false;
  const usage = message.usage || message.tokens;
  return usage ? usageTotal(usage) > 0 : false;
}

function usageTotal(usage) {
  const flat = ["totalTokens", "total_tokens", "input", "output", "input_tokens", "output_tokens", "reasoning"];
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

function finish() {
  if (process.stdout.isTTY) process.stdout.write("\n");
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
