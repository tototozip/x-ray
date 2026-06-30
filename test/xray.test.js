import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "xray.js");

test("counts existing Codex token_count rows", () => {
  const dir = temp();
  fs.writeFileSync(
    path.join(dir, "codex.jsonl"),
    [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
    ].join("\n"),
  );
  const result = run(["codex", "--once", "--path", dir]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /codex calls: 2/);
});

test("counts OpenClaw assistant usage rows", () => {
  const dir = temp();
  fs.writeFileSync(
    path.join(dir, "openclaw.jsonl"),
    [
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 0 } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 2 } } }),
      JSON.stringify({ type: "message", message: { role: "user", usage: { input: 10 } } }),
    ].join("\n"),
  );
  const result = run(["openclaw", "--once", "--path", dir]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /openclaw calls: 1/);
});

test("updates live from appended Codex rows", async () => {
  const dir = temp();
  const file = path.join(dir, "live.jsonl");
  fs.writeFileSync(file, "");

  const child = spawn(process.execPath, [bin, "codex", "--path", dir, "--poll", "100"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  await waitFor(() => output.includes("codex calls: 0"));
  fs.appendFileSync(file, `${JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })}\n`);
  await waitFor(() => output.includes("codex calls: 1"));
  child.kill("SIGINT");
});

test("counts opencode step-ended rows when sqlite3 is present", { skip: !has("sqlite3") }, () => {
  const db = path.join(temp(), "opencode.db");
  spawnSync("sqlite3", [
    db,
    "create table event(id text primary key, aggregate_id text, seq integer, type text, data text); insert into event values('1','a',1,'session.next.step.ended','{}'); insert into event values('2','a',2,'other','{}');",
  ]);
  const result = run(["opencode", "--once", "--path", db]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /opencode calls: 1/);
});

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
}

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xray-"));
}

function has(cmd) {
  return spawnSync("sh", ["-lc", `command -v ${cmd}`]).status === 0;
}

async function waitFor(fn) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("condition timed out");
}
