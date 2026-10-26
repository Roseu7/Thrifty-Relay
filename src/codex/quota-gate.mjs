import { DEFAULT_SETTINGS } from "../config.mjs";
import { readCodexRateLimits } from "./usage-limits.mjs";

const WINDOWS = Object.freeze([
  { name: "five_hour", threshold: "fiveHourLimitPercent", action: "fiveHourLimitAction" },
  { name: "weekly", threshold: "weeklyLimitPercent", action: "weeklyLimitAction" },
]);

function unavailable(snapshot, windows, reason = "unavailable") {
  return { code: "CODEX_QUOTA_UNAVAILABLE", allowed: false, reason, checked_at: snapshot?.checked_at ?? null, windows };
}

export function evaluateCodexQuotaSnapshot(snapshot, suppliedSettings = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...suppliedSettings };
  const rows = WINDOWS.map(({ name, threshold, action }) => {
    const quota = snapshot?.[name];
    return {
      name,
      remaining_percent: Number.isFinite(quota?.remaining_percent) && quota.remaining_percent >= 0 && quota.remaining_percent <= 100
        ? quota.remaining_percent : null,
      threshold_percent: settings[threshold],
      action: settings[action],
      resets_at: typeof quota?.resets_at === "string" ? quota.resets_at : null,
    };
  });
  const validSettings = WINDOWS.every(({ threshold, action }) =>
    Number.isInteger(settings[threshold]) && settings[threshold] >= 0 && settings[threshold] <= 100 &&
    ["warn", "block"].includes(settings[action]));
  if (!validSettings) return unavailable(snapshot, rows, "invalid_settings");
  if (snapshot?.status !== "ok" || rows.some(row => row.remaining_percent === null)) {
    return unavailable(snapshot, rows, "incomplete_snapshot");
  }

  const reached = rows.filter(row => row.remaining_percent <= row.threshold_percent);
  const blocked = reached.filter(row => row.action === "block");
  if (blocked.length) return {
    code: "CODEX_QUOTA_BLOCKED", allowed: false, checked_at: snapshot.checked_at ?? null,
    windows: rows, reached: reached.map(row => row.name), blocked: blocked.map(row => row.name),
  };
  const warned = reached.filter(row => row.action === "warn");
  if (warned.length) return {
    code: "CODEX_QUOTA_APPROVAL_REQUIRED", allowed: false, checked_at: snapshot.checked_at ?? null,
    windows: rows, reached: reached.map(row => row.name), warned: warned.map(row => row.name),
  };
  return { code: "CODEX_QUOTA_ALLOWED", allowed: true, checked_at: snapshot.checked_at ?? null, windows: rows };
}

export async function evaluateCodexQuota({ settings, quotaReader = readCodexRateLimits } = {}) {
  let snapshot;
  try { snapshot = await quotaReader(); }
  catch { return unavailable(null, evaluateCodexQuotaSnapshot(null, settings).windows, "query_failed"); }
  return evaluateCodexQuotaSnapshot(snapshot, settings);
}
