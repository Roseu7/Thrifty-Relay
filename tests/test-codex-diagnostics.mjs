import assert from "node:assert/strict";
import { classifyCodexFailure, sanitizeDiagnostic } from "../src/codex/diagnostics.mjs";

export function testCodexDiagnostics() {
  const secret = "sk-test-key-not-for-network";
  const token = "Bearer fixture-secret-token";
  const raw = { message: "connection reset: " + secret + " " + token,
    code: "ECONNRESET", status: 503, stack: "sensitive stack" };
  const classified = classifyCodexFailure(raw, { phase: "event_stream", origin: "sdk_exception", events_seen: 4 });
  assert.equal(classified.code, "CODEX_TURN_FAILED");
  assert.deepEqual(classified.diagnostic, {
    origin: "sdk_exception", phase: "event_stream", category: "network",
    thread_started: false, http_status: 503, events_seen: 4
  });
  assert(!JSON.stringify(classified).includes(secret));
  assert(!JSON.stringify(classified).includes("fixture-secret-token"));
  assert(!JSON.stringify(classified).includes("sensitive stack"));

  for (const [input, code, category] of [
    [{ status: 401 }, "CODEX_AUTH_FAILED", "authentication"],
    [{ message: "weekly usage limit reached" }, "CODEX_USAGE_LIMIT", "usage_limit"],
    [{ message: "model gpt-6-luna not available" }, "CODEX_MODEL_UNAVAILABLE", "model_unavailable"],
    [{ status: 429 }, "CODEX_USAGE_LIMIT", "usage_limit"],
    [{ status: 502 }, "CODEX_TURN_FAILED", "server"],
    [{ status: 400, message: "invalid payload" }, "CODEX_TURN_FAILED", "request_rejected"],
    [{ message: "request timed out" }, "CODEX_TURN_FAILED", "timeout"],
    [{ message: "unknown failure" }, "CODEX_TURN_FAILED", "sdk_error"]
  ]) {
    const result = classifyCodexFailure(input);
    assert.equal(result.code, code);
    assert.equal(result.diagnostic.category, category);
  }
  const unsafe = sanitizeDiagnostic({
    origin: token, phase: "C:\\secret", category: secret, http_status: 200,
    thread_started: "true", events_seen: 2 ** 40, worker_exit_code: 900,
    error_message: secret, stderr: token, stack: "private"
  });
  assert.deepEqual(unsafe, {
    origin: "adapter", phase: "unknown", category: "unknown",
    thread_started: false, events_seen: 1000000
  });
  assert.equal(sanitizeDiagnostic(null), null);
  console.log("CODEX_DIAGNOSTICS_UNIT_OK");
}
