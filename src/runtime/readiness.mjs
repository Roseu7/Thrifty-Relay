// The tunnel's own health endpoint is the only readiness signal the product trusts: a task
// state of "Running" means the launcher process exists, not that the tunnel connected.
const READINESS_URL = "http://127.0.0.1:8080/readyz";

export async function probeReadyEndpoint({ fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (typeof fetchImpl !== "function") return false;
  try {
    const response = await fetchImpl(READINESS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return response?.ok === true;
  } catch {
    return false;
  }
}

export async function waitForReady({
  probe = probeReadyEndpoint,
  timeoutMs = 60_000,
  intervalMs = 1000,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
