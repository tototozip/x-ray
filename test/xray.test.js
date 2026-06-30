import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "xray-state-"));
const {
  countOtelCalls,
  relaunchRunningCodexApp,
  withXrayOtelConfig,
} = await import("../bin/xray.js");

test("counts Codex request OTLP log events", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.websocket_request", { "conversation.id": "one", model: "gpt-5.5" }),
      otelRecord("codex.api_request", { "http.route": "/responses", "conversation.id": "one", model: "gpt-5.5" }),
      otelRecord("codex.api_request", { "http.route": "/models" }),
      otelRecord("codex.sse_event"),
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 1);
});

test("counts one call for each outbound websocket model request", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.websocket_request", { "api.path": "responses", "conversation.id": "one", model: "gpt-5.5" }),
      otelRecord("codex.api_request", { "api.path": "responses", "conversation.id": "one", model: "gpt-5.5" }),
      otelRecord("codex.websocket.request", { "api.path": "responses", "conversation.id": "two", model: "gpt-5.5" }),
      otelRecord("codex.api_request", { "api.path": "responses", "conversation.id": "two", model: "gpt-5.5" }),
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 2);
});

test("counts HTTP Responses API request telemetry when it is the LLM call signal", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.api_request", {
        endpoint: "/responses",
        "conversation.id": "api-only",
        model: "gpt-5.5",
      }),
      otelRecord("codex.api_request", { endpoint: "/models" }),
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 1);
});

test("dedupes API and websocket telemetry for the same LLM request", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.api_request", {
        endpoint: "/responses",
        "conversation.id": "same",
        "event.timestamp": "2026-06-30T16:23:58.100Z",
        model: "gpt-5.5",
      }),
      otelRecord("codex.websocket_request", {
        "conversation.id": "same",
        "event.timestamp": "2026-06-30T16:23:58.300Z",
        model: "gpt-5.5",
      }),
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 1);
});

test("dedupes repeated websocket telemetry for the same request", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.websocket_request", {
        "conversation.id": "same",
        "event.timestamp": "2026-06-30T16:23:58.318Z",
        model: "gpt-5.5",
      }),
      otelRecord("codex.websocket_request", {
        "conversation.id": "same",
        "event.timestamp": "2026-06-30T16:23:58.877Z",
        model: "gpt-5.5",
      }),
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 1);
});

test("keeps separate websocket requests outside the duplicate window", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.websocket_request", {
        "conversation.id": "same",
        "event.timestamp": "2026-06-30T16:23:58.000Z",
        model: "gpt-5.5",
      }),
      otelRecord("codex.websocket_request", {
        "conversation.id": "same",
        "event.timestamp": "2026-06-30T16:24:01.000Z",
        model: "gpt-5.5",
      }),
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 2);
});

test("ignores OTLP records that are not Codex request events", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.sse_event"),
      otelRecord("codex.exec_command_begin"),
      otelRecord("codex.tool_call"),
      { attributes: [] },
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 0);
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

test("does not relaunch Codex app when disabled or off macOS", () => {
  assert.equal(relaunchRunningCodexApp({ shouldRelaunch: false, platform: "darwin" }), false);
  assert.equal(relaunchRunningCodexApp({ shouldRelaunch: true, platform: "linux" }), false);
});

test("relaunches an already-running Codex app", () => {
  const commands = [];
  let running = true;
  const relaunched = relaunchRunningCodexApp({
    platform: "darwin",
    isRunning: () => running,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      if (command === "osascript") running = false;
    },
    wait: (done) => done(),
    log: () => {},
  });

  assert.equal(relaunched, true);
  assert.deepEqual(commands.map(([command]) => command), ["osascript", "open"]);
});

function otelRecord(name, attrs = {}) {
  return {
    attributes: [
      { key: "event.name", value: { stringValue: name } },
      ...Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
    ],
  };
}
