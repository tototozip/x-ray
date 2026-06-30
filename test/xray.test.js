import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "xray-state-"));
const {
  countOtelCalls,
  installCodexTelemetryConfig,
  withXrayOtelConfig,
} = await import("../bin/xray.js");

test("installs a single temporary Codex otel block", () => {
  const config = `model = "gpt-5.5"

[otel]
enabled = false
environment = "existing"

[projects."/tmp"]
trust_level = "trusted"
`;

  const next = withXrayOtelConfig(config, 12345);
  assert.equal((next.match(/\[otel\]/g) || []).length, 1);
  assert.match(next, /endpoint = "http:\/\/127\.0\.0\.1:12345\/v1\/logs"/);
  assert.match(next, /metrics_exporter = \{ otlp-http = \{ endpoint = "http:\/\/127\.0\.0\.1:12345\/v1\/metrics"/);
  assert.match(next, /\[projects\."\/tmp"\]/);
  assert.doesNotMatch(next, /environment = "existing"/);
});

test("restores Codex config exactly after the xray session", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "xray-codex-"));
  const configPath = path.join(codexHome, "config.toml");
  const original = `model = "gpt-5.5"

[projects."/repo"]
trust_level = "trusted"
`;
  fs.writeFileSync(configPath, original, { mode: 0o600 });

  const restore = installCodexTelemetryConfig(54321, { codexHome });
  assert.notEqual(fs.readFileSync(configPath, "utf8"), original);
  restore();
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});

test("counts Codex API and websocket request logs", () => {
  const payload = logsPayload([
    logRecord("codex.api_request"),
    logRecord("codex.websocket.request"),
    logRecord("codex.sse_event"),
  ]);
  assert.equal(countOtelCalls(payload), 2);
});

test("does not count model list API telemetry as an LLM call", () => {
  const payload = logsPayload([
    logRecord("codex.api_request", { "http.route": "/models" }),
    logRecord("codex.api_request", {}, "GET /models Request completed"),
    logRecord("codex.api_request", { "http.route": "/responses" }),
  ]);
  assert.equal(countOtelCalls(payload), 1);
});

test("uses metric deltas only when no request logs are present", () => {
  const metricState = new Map();
  const first = metricsPayload("codex.websocket.request.duration_ms", 3, 2);
  const second = metricsPayload("codex.websocket.request.duration_ms", 5, 2);

  assert.equal(countOtelCalls(first, { metricState }), 3);
  assert.equal(countOtelCalls(second, { metricState }), 2);
  assert.equal(countOtelCalls(logsPayload([logRecord("codex.websocket.request")]), { metricState }), 1);
});

test("installed Codex accepts the generated otel config", { skip: !commandExists("codex") }, () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "xray-codex-"));
  fs.writeFileSync(path.join(codexHome, "config.toml"), withXrayOtelConfig("", 1), { mode: 0o600 });
  const result = spawnSync("codex", ["--strict-config", "doctor", "--summary"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
    timeout: 30_000,
  });

  assert.match(result.stdout, /config\s+loaded/, result.stderr || result.stdout);
});

function logsPayload(records) {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] };
}

function logRecord(name, attrs = {}, body = "Request completed") {
  return {
    body: { stringValue: body },
    attributes: [
      { key: "event.name", value: { stringValue: name } },
      ...Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
    ],
  };
}

function metricsPayload(name, count, temporality) {
  return {
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [{
          name,
          histogram: {
            aggregationTemporality: temporality,
            dataPoints: [{
              startTimeUnixNano: "1",
              attributes: [{ key: "transport", value: { stringValue: "websocket" } }],
              count,
            }],
          },
        }],
      }],
    }],
  };
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}
