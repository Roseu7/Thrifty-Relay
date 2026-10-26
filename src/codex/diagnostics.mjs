// Strict allowlists: never persist exception messages, endpoint paths, stderr or SDK payloads.
const PHASES = new Set(["worker_boot", "sdk_init", "thread_init", "turn_start", "event_stream", "turn_failed", "worker_exit", "unknown"]);
const ORIGINS = new Set(["sdk_event", "sdk_exception", "worker_exit", "adapter"]);
const CATEGORIES = new Set(["authentication", "usage_limit", "model_unavailable", "network", "timeout", "server", "request_rejected", "sdk_error", "incomplete_result", "worker_exit", "unknown"]);

export function sanitizeDiagnostic(raw) {
  if (!raw || typeof raw !== "object") return null;
  const phase = PHASES.has(raw.phase) ? raw.phase : "unknown";
  const origin = ORIGINS.has(raw.origin) ? raw.origin : "adapter";
  const category = CATEGORIES.has(raw.category) ? raw.category : "unknown";
  const out = { origin, phase, category, thread_started: raw.thread_started === true };
  if (Number.isInteger(raw.http_status) && raw.http_status >= 400 && raw.http_status <= 599) out.http_status = raw.http_status;
  if (Number.isSafeInteger(raw.events_seen) && raw.events_seen >= 0) out.events_seen = Math.min(raw.events_seen, 1000000);
  if (Number.isSafeInteger(raw.worker_exit_code) && raw.worker_exit_code >= 0 && raw.worker_exit_code <= 255) out.worker_exit_code = raw.worker_exit_code;
  return out;
}

export function classifyCodexFailure(error, { phase = "unknown", origin = "sdk_exception", thread_started = false, events_seen = 0 } = {}) {
  // Messages are used only to select an enum; never sent over IPC or returned to callers.
  const message = String(typeof error === "string" ? error : error?.message ?? "").slice(0, 4096);
  const status = Number.isInteger(error?.status) ? error.status :
    Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  const errCode = typeof error?.code === "string" ? error.code.slice(0, 64) : "";
  let category = "sdk_error";
  let code = "CODEX_TURN_FAILED";
  if (status === 401 || status === 403 || /\b(?:unauthorized|unauthenticated|invalid credential|authentication failed|sign.in)\b/i.test(message)) {
    category = "authentication"; code = "CODEX_AUTH_FAILED";
  } else if (status === 429 || /\b(?:usage limit|rate limit|limit reached|quota exceeded|too many requests)\b/i.test(message)) {
    category = "usage_limit"; code = "CODEX_USAGE_LIMIT";
  } else if (/\bmodel\b.{0,100}\b(?:not available|not supported|not found|does not exist|unavailable)\b|access.{0,60}\bmodel\b/i.test(message)) {
    category = "model_unavailable"; code = "CODEX_MODEL_UNAVAILABLE";
  } else if (/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE)\b/i.test(errCode + " " + message) || /\b(?:connection reset|connection refused|network error|dns failure)\b/i.test(message)) {
    category = "network";
  } else if (/timeout|timed out/i.test(errCode + " " + message)) {
    category = "timeout";
  } else if (status >= 500 && status <= 599) {
    category = "server";
  } else if (status >= 400 && status <= 499) {
    category = "request_rejected";
  }
  return { code, diagnostic: sanitizeDiagnostic({ origin, phase, category, http_status: status, thread_started, events_seen }) };
}
