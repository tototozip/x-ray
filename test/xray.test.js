import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "xray-state-"));
const {
  countOtelCalls,
  countResponseCreatedRows,
  readMaxLogId,
  readNewLogCalls,
  responseCreatedId,
  withXrayOtelConfig,
} = await import("../bin/xray.js");

test("extracts Codex response ids from websocket and SSE logs", () => {
  assert.equal(
    responseCreatedId('Received message {"type":"response.created","response":{"id":"resp_abc123","status":"in_progress"}}'),
    "resp_abc123",
  );
  assert.equal(
    responseCreatedId('SSE event: {"type":"response.created","response":{"id":"resp_def456","status":"in_progress"}}'),
    "resp_def456",
  );
});

test("ignores non-request response events and embedded command text", () => {
  assert.equal(responseCreatedId('Received message {"type":"response.completed","response":{"id":"resp_abc123"}}'), null);
  assert.equal(responseCreatedId('ToolCall: shell_command {"command":"echo response.created resp_fake"}'), null);
});

test("counts unique response.created rows", () => {
  const seen = new Set();
  const rows = [
    row(1, 'Received message {"type":"response.created","response":{"id":"resp_one"}}'),
    row(2, 'Received message {"type":"response.created","response":{"id":"resp_one"}}'),
    row(3, 'SSE event: {"type":"response.created","response":{"id":"resp_two"}}'),
  ];
  assert.equal(countResponseCreatedRows(rows, seen), 2);
  assert.equal(countResponseCreatedRows(rows, seen), 0);
});

test("counts only pre-existing process pids when requested", () => {
  const rows = [
    row(1, 'Received message {"type":"response.created","response":{"id":"resp_one"}}', "pid:111:aaa"),
    row(2, 'Received message {"type":"response.created","response":{"id":"resp_two"}}', "pid:222:bbb"),
  ];
  assert.equal(countResponseCreatedRows(rows, new Set(), { allowedPids: new Set(["111"]) }), 1);
});

test("reads new Codex calls from sqlite logs", { skip: !commandExists("sqlite3") }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-db-"));
  const db = path.join(dir, "logs_2.sqlite");
  sqlite(db, "create table logs (id integer primary key autoincrement, process_uuid text, feedback_log_body text);");
  sqlite(db, `insert into logs (process_uuid, feedback_log_body) values
    ('pid:111:aaa', 'Received message {"type":"response.created","response":{"id":"resp_old"}}');`);

  const baseline = readMaxLogId(db);
  sqlite(db, `insert into logs (process_uuid, feedback_log_body) values
    ('pid:111:aaa', 'Received message {"type":"response.created","response":{"id":"resp_new_one"}}'),
    ('pid:111:aaa', 'SSE event: {"type":"response.created","response":{"id":"resp_new_two"}}'),
    ('pid:111:aaa', 'Received message {"type":"response.completed","response":{"id":"resp_new_two"}}');`);

  const seen = new Set();
  const first = readNewLogCalls(db, baseline, seen);
  assert.equal(first.calls, 2);
  assert.equal(first.lastId, 4);

  const second = readNewLogCalls(db, first.lastId, seen);
  assert.equal(second.calls, 0);
  assert.equal(second.lastId, 4);
});

test("counts Codex request OTLP log events", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.websocket_request"),
      otelRecord("codex.api_request", { "http.route": "/responses" }),
      otelRecord("codex.api_request", { "http.route": "/models" }),
      otelRecord("codex.sse_event"),
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 2);
});

test("replaces existing otel config with the xray exporter", () => {
  const config = `model = "gpt-5.5"

[otel]
exporter = "old"

[projects."/tmp"]
trust_level = "trusted"
`;
  const next = withXrayOtelConfig(config, 1234);
  assert.equal((next.match(/\[otel\]/g) || []).length, 1);
  assert.match(next, /127\.0\.0\.1:1234/);
  assert.doesNotMatch(next, /old/);
  assert.match(next, /\[projects\."\/tmp"\]/);
});

function row(id, feedback_log_body, process_uuid = null) {
  return { id, feedback_log_body, process_uuid };
}

function otelRecord(name, attrs = {}) {
  return {
    attributes: [
      { key: "event.name", value: { stringValue: name } },
      ...Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
    ],
  };
}

function sqlite(db, sql) {
  const result = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}
