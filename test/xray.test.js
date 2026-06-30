import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Use a throwaway state dir so cert generation doesn't touch the real one.
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "xray-"));
const { isCall, ensureCerts } = await import("../bin/xray.js");

test("counts POSTs to inference endpoints only", () => {
  assert.ok(isCall("POST", "/v1/responses"));
  assert.ok(isCall("POST", "/v1/messages?beta=true"));
  assert.ok(isCall("POST", "/v1/chat/completions"));
  assert.ok(isCall("POST", "/backend-api/codex/responses"));

  assert.ok(!isCall("GET", "/v1/responses")); // websocket upgrade / polling
  assert.ok(!isCall("POST", "/v1/models"));
  assert.ok(!isCall("POST", "/v1/responses/abc/cancel"));
});

test("generates a CA-signed leaf covering the intercepted hosts", () => {
  const certs = ensureCerts();
  for (const f of [certs.ca, certs.leafCert, certs.leafKey, certs.bundle]) {
    assert.ok(fs.existsSync(f), `${f} should exist`);
  }

  const verify = spawnSync("openssl", ["verify", "-CAfile", certs.ca, certs.leafCert], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);

  const san = spawnSync("openssl", ["x509", "-in", certs.leafCert, "-noout", "-ext", "subjectAltName"], { encoding: "utf8" }).stdout;
  for (const host of ["api.openai.com", "api.anthropic.com", "chatgpt.com"]) {
    assert.match(san, new RegExp(host.replace(/\./g, "\\.")));
  }

  // The bundle merges system roots with our CA, so it must hold many certs.
  const count = (fs.readFileSync(certs.bundle, "utf8").match(/BEGIN CERTIFICATE/g) || []).length;
  assert.ok(count > 1, `bundle should contain system roots + our CA, got ${count}`);
});

test("reuses existing certs instead of regenerating", () => {
  const a = ensureCerts();
  const before = fs.statSync(a.leafCert).mtimeMs;
  const b = ensureCerts();
  assert.equal(fs.statSync(b.leafCert).mtimeMs, before);
});
