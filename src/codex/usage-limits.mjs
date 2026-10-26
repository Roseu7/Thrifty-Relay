import { spawn } from "node:child_process";
import { VERSION } from "../version.mjs";

// App Server exposes quota snapshots separately from per-turn SDK token usage.
// This reader never submits a Codex turn, purchases credits, or changes authentication.
export function normalizeCodexRateLimits(data) {
  const snapshot = data?.rateLimitsByLimitId?.codex ||
    (data?.rateLimits?.limitId === "codex" || data?.rateLimits?.limitId == null ? data?.rateLimits : null);
  const result = { status: "unavailable", five_hour: null, weekly: null };
  if (!snapshot) return result;
  for (const item of [snapshot.primary, snapshot.secondary]) {
    if (!item || !Number.isFinite(item.usedPercent)) continue;
    const window = item.windowDurationMins === 300 ? "five_hour" :
      item.windowDurationMins === 10080 ? "weekly" : null;
    if (!window) continue;
    const remaining_percent = Math.max(0, Math.min(100, 100 - item.usedPercent));
    const millis = Number.isSafeInteger(item.resetsAt) ? item.resetsAt * 1000 : null;
    const date = millis !== null && Number.isFinite(millis) ? new Date(millis) : null;
    result[window] = { remaining_percent, resets_at: date && !Number.isNaN(date.getTime()) ?
      date.toISOString() : null };
  }
  if (result.five_hour || result.weekly) result.status = "ok";
  return result;
}

export function readCodexRateLimits({ timeoutMs = 8000 } = {}) {
  return new Promise(resolve => {
    let child, finished = false, buffer = "";
    const complete = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child?.stdin.end(); child?.kill(); } catch { /* Best effort child cleanup */ }
      resolve({ ...value, checked_at: new Date().toISOString() });
    };
    // Never expose app-server raw payloads or stderr (may contain account metadata).
    let timer = setTimeout(() => complete({ status: "unavailable", reason: "timeout", five_hour: null, weekly: null }), timeoutMs);
    try {
      child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.stderr.resume();
      child.on("error", () => complete({ status: "unavailable", reason: "spawn_failed", five_hour: null, weekly: null }));
      child.on("close", () => complete({ status: "unavailable", reason: "connection_closed", five_hour: null, weekly: null }));
      const send = (payload) => {
        if (finished) return;
        try { child.stdin.write(JSON.stringify(payload) + "\n"); }
        catch { complete({ status: "unavailable", reason: "transport_error", five_hour: null, weekly: null }); }
      };
      child.stdin.on("error", () => complete({ status: "unavailable", reason: "transport_error", five_hour: null, weekly: null }));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        if (finished) return;
        buffer += chunk;
        if (buffer.length > 256000) {
          complete({ status: "unavailable", reason: "response_too_large", five_hour: null, weekly: null });
          return;
        }
        let end;
        while (!finished && (end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            if (message.error) {
              complete({ status: "unavailable", reason: "initialize_failed", five_hour: null, weekly: null });
              return;
            }
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/rateLimits/read", params: {} });
          } else if (message.id === 2) {
            if (message.error) {
              complete({ status: "unavailable", reason: "query_failed", five_hour: null, weekly: null });
              return;
            }
            try { complete(normalizeCodexRateLimits(message.result)); }
            catch { complete({ status: "unavailable", reason: "invalid_response", five_hour: null, weekly: null }); }
          }
        }
      });
      send({ id: 1, method: "initialize", params: {
        clientInfo: { name: "thriftyrelay", title: "ThriftyRelay", version: VERSION }, capabilities: {}
      } });
    } catch {
      complete({ status: "unavailable", reason: "spawn_failed", five_hour: null, weekly: null });
    }
  });
}
