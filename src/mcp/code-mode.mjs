import { Worker } from "node:worker_threads";

const LIMITS = Object.freeze({
  codeChars: 64000,
  wallMs: 60000,
  cpuMs: 2000,
  memoryBytes: 32 * 1024 * 1024,
  calls: 30,
  concurrent: 4,
  argumentBytes: 256 * 1024,
  resultBytes: 256 * 1024,
  outputChars: 12000,
  outputItems: 32,
});
const MAX_ACTIVE = 3;
let activeRuns = 0;

function fail(code, output = "", status) {
  return {
    result: {
      isError: true,
      content: [{ type: "text", text: "[CODE_MODE_" + code + "]" + (output ? "\n" + output : "") }],
    },
    summary: "code: ERROR (" + code + ")",
    failed: true,
    ...(status ? { status } : {}),
  };
}

// An invocation owns its Worker, wall/CPU/memory/call limits and accepted operations.
// Terminating a Worker never implies already-dispatched PC operations were rolled back.
export async function runCodeMode(code, invokeStep, context = {}) {
  if (typeof code !== "string" || !code.trim() || code.length > LIMITS.codeChars) {
    return fail("CODE_LIMIT");
  }
  if (activeRuns >= MAX_ACTIVE) return fail("BUSY");
  activeRuns++;
  const pending = new Set();
  const output = [];
  let count = 0;
  let worker;
  const localAbort = new AbortController();
  const signal = context.signal
    ? AbortSignal.any([context.signal, localAbort.signal])
    : localAbort.signal;
  let resolvedStatus = null;
  try {
    const state = await new Promise((resolve) => {
      let finished = false;
      const complete = (reason = null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);
        if (reason) localAbort.abort();
        void worker?.terminate();
        resolve(reason);
      };
      const onAbort = () => complete(context.reason?.() === "timed_out" ? "TIMED_OUT" : "CANCELLED");
      const timer = setTimeout(() => complete("TIME_LIMIT"), LIMITS.wallMs);
      if (context.signal?.aborted) { onAbort(); return; }
      context.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        worker = new Worker(new URL("./code-mode-worker.cjs", import.meta.url), {
          workerData: { code, limits: LIMITS },
          resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        });
      } catch (error) { complete("WORKER_ERROR: " + String(error)); return; }

      worker.on("error", (error) => complete("WORKER_ERROR: " + String(error).slice(0, 200)));
      worker.on("exit", (exitCode) => complete("WORKER_EXIT_" + exitCode));
      worker.on("message", (message) => {
        if (finished) return;
        if (message?.type === "done") { complete(message.error || null); return; }
        if (message?.type === "emit") {
          if (typeof message.json !== "string") { complete("BRIDGE_ERROR"); return; }
          try {
            const value = JSON.parse(message.json);
            if (typeof value !== "string") throw Error("expected string");
            if (output.join("").length + value.length > LIMITS.outputChars) {
              complete("OUTPUT_LIMIT"); return;
            }
            output.push(value);
          } catch { complete("OUTPUT_INVALID"); }
          return;
        }
        if (message?.type !== "call" || !Number.isSafeInteger(message.id) ||
            typeof message.json !== "string") {
          complete("BRIDGE_ERROR"); return;
        }
        if (count >= LIMITS.calls || pending.size >= LIMITS.concurrent ||
            Buffer.byteLength(message.json) > LIMITS.argumentBytes) {
          complete("CALL_LIMIT"); return;
        }
        let request;
        try { request = JSON.parse(message.json); }
        catch { complete("BRIDGE_ERROR"); return; }
        count++;
        const promise = Promise.resolve()
          .then(() => invokeStep(request, { ...context, signal,
            reason: () => context.signal?.aborted ? (context.reason?.() || "cancelled") : "timed_out" }))
          .then(
            (value) => ({ ok: !value.failed, summary: value.summary,
              output: String(value.output ?? "").slice(0, 12000),
              ...(value.failed ? { error: value.summary + ": " + String(value.output ?? "").slice(0, 900) } : {}) }),
            (error) => ({ ok: false, error: String(error).slice(0, 1000) }),
          )
          .then((value) => {
            if (finished) return;
            let json;
            try { json = JSON.stringify(value); }
            catch { complete("RESULT_INVALID"); return; }
            if (Buffer.byteLength(json) > LIMITS.resultBytes) { complete("RESULT_LIMIT"); return; }
            worker.postMessage({ type: "result", id: message.id, json });
          })
          .catch((error) => { if (!finished) complete("BRIDGE_ERROR: " + String(error).slice(0, 120)); })
          .finally(() => { pending.delete(promise); });
        pending.add(promise);
      });
    });
    resolvedStatus = state;
    if (!resolvedStatus && pending.size) resolvedStatus = "UNAWAITED_CALLS";
    if (resolvedStatus) {
      const detail = output.join("\n");
      const sideEffects = count ? "\n" + count + " operation(s) dispatched; inspect state before retrying." : "";
      return fail(resolvedStatus, detail + sideEffects,
        resolvedStatus === "CANCELLED" ? "cancelled"
          : ["TIME_LIMIT", "TIMED_OUT"].includes(resolvedStatus) ? "timed_out" : undefined);
    }
    return {
      result: { content: [{ type: "text", text: output.join("\n") || "(No text emitted)" }] },
      summary: "code: PASS (" + count + " operations)",
      failed: false,
    };
  } finally {
    localAbort.abort();
    if (pending.size) {
      void Promise.allSettled([...pending]).then(() => { activeRuns--; });
    } else {
      activeRuns--;
    }
  }
}
