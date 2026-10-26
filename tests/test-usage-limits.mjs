import assert from "node:assert/strict";
import { normalizeCodexRateLimits, readCodexRateLimits } from "../src/codex/usage-limits.mjs";
const input = { rateLimitsByLimitId: { codex: { limitId: "codex",
  primary: { usedPercent: 46, windowDurationMins: 300, resetsAt: 1792190625 },
  secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1792655623 }
} } };
let result = normalizeCodexRateLimits(input);
assert.equal(result.status, "ok");
assert.equal(result.five_hour.remaining_percent, 54);
assert.equal(result.weekly.remaining_percent, 63);
assert.match(result.weekly.resets_at, /^2026-/);
result = normalizeCodexRateLimits({ rateLimits: {
  limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null }, secondary: null
} });
assert.equal(result.status, "ok");
assert.equal(result.five_hour, null);
assert.equal(result.weekly.remaining_percent, 90);
assert.equal(result.weekly.resets_at, null);
assert.equal(normalizeCodexRateLimits({ rateLimits: { limitId: "codex", primary: {
  usedPercent: 1, windowDurationMins: 300, resetsAt: 9007199254740991 } } }).five_hour.resets_at, null);
assert.equal(normalizeCodexRateLimits({ rateLimits: { limitId: "other", primary: { usedPercent: 1, windowDurationMins: 300 } } }).status, "unavailable");
assert.equal(normalizeCodexRateLimits({}).status, "unavailable");
console.log("QUOTA_UNIT_OK");
if (process.argv.includes("--live")) {
  const live = await readCodexRateLimits();
  assert.equal(live.status, "ok", "app-server limits must be readable on this PC");
  assert.ok(live.five_hour || live.weekly);
  console.log("QUOTA_LIVE_OK " + JSON.stringify(live));
}
