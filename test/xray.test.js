import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "xray-state-"));
const {
  collectOtelRequests,
  countOtelCalls,
  relaunchRunningCodexApp,
  withXrayClaudeSettings,
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

test("extracts per-model request counts from telemetry", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      otelRecord("codex.websocket_request", { "conversation.id": "codex_one", model: "gpt-5.5" }),
      {
        body: { stringValue: "claude_code.api_request" },
        attributes: [
          attr("event.name", "api_request"),
          attr("request_id", "req_one"),
          attr("model", "claude-sonnet-4-6"),
        ],
      },
    ] }] }],
  };
  assert.deepEqual(collectOtelRequests(payload).map((request) => request.model), [
    "gpt-5.5",
    "claude-sonnet-4-6",
  ]);
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

test("counts Claude Code API request telemetry as one LLM call", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      {
        body: { stringValue: "claude_code.api_request" },
        attributes: [
          attr("event.name", "api_request"),
          attr("request_id", "req_one"),
          attr("session.id", "session_one"),
          attr("model", "claude-sonnet-4-6"),
          attr("input_tokens", "3"),
          attr("output_tokens", "15"),
        ],
      },
    ] }] }],
  };
  assert.equal(countOtelCalls(payload), 1);
});

test("dedupes repeated Claude Code request telemetry by request id", () => {
  const payload = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      {
        body: { stringValue: "claude_code.api_request" },
        attributes: [
          attr("event.name", "api_request"),
          attr("request_id", "req_same"),
          attr("model", "claude-sonnet-4-6"),
          attr("event.timestamp", "2026-07-01T10:00:00.100Z"),
        ],
      },
      {
        body: { stringValue: "claude_code.api_request" },
        attributes: [
          attr("event.name", "api_request"),
          attr("request_id", "req_same"),
          attr("model", "claude-sonnet-4-6"),
          attr("event.timestamp", "2026-07-01T10:00:00.200Z"),
        ],
      },
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

test("adds Claude Code telemetry env settings without dropping existing settings", () => {
  const settings = JSON.stringify({
    model: "sonnet",
    env: {
      EXISTING: "keep",
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
    },
  });
  const next = JSON.parse(withXrayClaudeSettings(settings, 4321));
  assert.equal(next.model, "sonnet");
  assert.equal(next.env.EXISTING, "keep");
  assert.equal(next.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.equal(next.env.OTEL_LOGS_EXPORTER, "otlp");
  assert.equal(next.env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:4321");
  assert.equal(next.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "http://127.0.0.1:4321/v1/logs");
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
      attr("event.name", name),
      ...Object.entries(attrs).map(([key, value]) => attr(key, value)),
    ],
  };
}

function attr(key, value) {
  return { key, value: { stringValue: value } };
}
