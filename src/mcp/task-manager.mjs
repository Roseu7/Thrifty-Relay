import fs from "node:fs/promises";
import path from "node:path";
import { writeRecord } from "./task-storage.mjs";
import { createExecutionGuard, exists } from "./execution-guard.mjs";
import { cleanupScratch, createTaskScratch, resolveScratchStep, scratchOutcome } from "./scratch.mjs";
import { MAX_CODEX_AGENTS } from "../config.mjs";
import {
  MAX_TASK_IMAGES, MAX_TASK_IMAGE_BYTES, extractImages, imageBlocks, storeImages,
  loadImages, storedImageRefs, removeImages, summarizeImageOmissions,
} from "./image-content.mjs";

export const MAX_INSPECT_WAIT_MS = 120000;

async function waitForCompletion(entry, milliseconds, signal, isComplete) {
  if (!entry || milliseconds === 0 || signal?.aborted || isComplete()) return;
  await new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      entry.waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    entry.waiters.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function createTaskManager({ dir, executeStep, textOf, compactText, truncate, redactHistory, taskId, idPattern,
                                     scratchRoot = null, scratchPlatform = process.platform, explainMissing = null }) {
  const active = new Map();
  const MAX_ACTIVE = MAX_CODEX_AGENTS;
  const MAX_LOGS = 100;
  const guard = createExecutionGuard({ dir });
  const mutates = step => !["read", "search"].includes(step.kind);

  async function persist(task, prune = false) {
    const file = path.join(dir, task.id + ".json");
    await writeRecord(file, task);
    if (!prune) return;
    let protectedTask;
    if (await exists(guard.active)) {
      try { protectedTask = JSON.parse(await fs.readFile(guard.active, "utf8")).task_id; }
      catch { return; } // Preserve evidence when the execution claim is damaged.
    }
    const files = (await fs.readdir(dir)).filter((name) => /^task_[a-z0-9]+_[a-z0-9]{6}\.json$/.test(name)).sort();
    let excess = Math.max(0, files.length - MAX_LOGS);
    for (const name of files) {
      if (!excess) break;
      const id = name.slice(0, -5);
      if (active.has(id)) continue;
      if (id === protectedTask) continue;
      // The read/parse and the decision stay outside the deletion catch: a defect here must
      // not look like a concurrent removal and silently disable pruning.
      let source;
      try { source = await fs.readFile(path.join(dir, name), "utf8"); }
      catch { continue; }
      let old;
      try { old = JSON.parse(source); }
      catch { continue; }
      // The same rule that protects scratch data must protect the record describing it.
      // Pruning a recovered or unresolved record would turn its retained directory into an
      // orphan that the scratch sweep is then allowed to age out.
      if (scratchOutcome(old) === "protect") continue;
      try { await fs.unlink(path.join(dir, name)); }
      catch { continue; }
      await removeImages(dir, id).catch(() => {});
      excess--;
    }
  }

  function response(message, isError = false, images = []) {
    return { content: [{ type: "text", text: message }, ...images], ...(isError ? { isError: true } : {}) };
  }

  async function execute(task, steps, stopOnError, maxExposed, entry) {
    const summary = [];
    const exposed = [];
    const exposedImages = [];
    const imageBudget = { images: MAX_TASK_IMAGES, bytes: MAX_TASK_IMAGE_BYTES };
    let budget = maxExposed;
    let lease;
    try {
      if (!steps.some(step => step.kind === "codex") && steps.some(mutates) && await guard.enabled()) {
        lease = await guard.acquire({ task_id: task.id, kind: "remote" });
        task.guard_state = "held";
      }
      task.status = "running";
      await persist(task);
      for (let index = 0; index < steps.length; index++) {
        if (entry.controller.signal.aborted) break;
        const step = steps[index];
        task.current_step = index;
        task.active_pid = null;
        await persist(task);
        let executed;
        try {
          executed = await executeStep(step, {
            signal: entry.controller.signal,
            async: task.mode === "async",
            task_id: task.id,
            reason: () => entry.abortReason,
            onPid: async (pid) => { task.active_pid = pid; if (lease) await lease.noteProcess(pid, true); },
          });
        } catch (error) {
          executed = {
            result: { isError: true, content: [{ type: "text", text: String(error) }] },
            summary: step.kind + ": ERROR " + String(error),
            failed: true,
            execution_unknown: mutates(step),
          };
        }
        const extracted = extractImages(["read", "call"].includes(step.kind) ? executed.result : null, imageBudget);
        imageBudget.images -= extracted.images.length;
        imageBudget.bytes -= extracted.bytes;
        const stored = await storeImages(dir, task.id, index, extracted.images);
        const notes = [summarizeImageOmissions(extracted.omitted),
          ...(stored.failed ? ["images unavailable: attachment storage failed"] : [])].filter(Boolean);
        const stepSummary = [executed.summary, ...notes].join("; ");
        if (step.expose === true && task.mode === "sync") exposedImages.push(...imageBlocks(extracted.images));
        const raw = compactText(textOf(executed.result));
        const status = executed.status || (executed.failed ? "failed" : "succeeded");
        if (executed.execution_unknown || (step.kind === "code" && executed.failed)) task.execution_unknown = true;
        task.steps.push({
          index, kind: step.kind, label: step.label || null, status,
          expose: step.expose === true,
          summary: redactHistory(stepSummary),
          failed: !!executed.failed,
          result: { content: [{ type: "text", text: step.kind === "codex" ? raw : redactHistory(raw) }, ...stored.refs] },
        });
        summary.push((index + 1) + ". [" + (executed.failed ? "ERROR" : "OK") + "] " +
          (step.label ? step.label + ": " : "") + stepSummary);
        if (step.expose && task.mode === "sync" && budget > 0 && raw) {
          const shown = truncate(raw, Math.min(budget, 8000));
          exposed.push("--- step " + (index + 1) + (step.label ? " (" + step.label + ")" : "") + " ---\n" + shown);
          budget -= shown.length;
        }
        task.active_pid = null;
        task.current_step = null;
        await persist(task);
        if (status === "timed_out") {
          task.status = "timed_out";
          break;
        }
        if (entry.controller.signal.aborted || status === "cancelled") break;
        if (executed.failed && stopOnError) break;
      }
      if (!["timed_out", "failed"].includes(task.status)) {
        if (entry.controller.signal.aborted) task.status = entry.abortReason || "cancelled";
        else task.status = task.steps.some((step) => step.failed) ? "failed" : "succeeded";
      }
    } catch (error) {
      task.status = "failed";
      task.error = redactHistory(String(error));
    } finally {
      if (entry.timer) clearTimeout(entry.timer);
      task.finished_at = new Date().toISOString();
      task.current_step = null;
      task.active_pid = null;
      if (lease) {
        try {
          if (task.execution_unknown || entry.controller.signal.aborted || task.error) {
            await lease.retain("REMOTE_TASK_UNCONFIRMED"); task.guard_state = "unknown";
          } else { await lease.release(); task.guard_state = "released"; }
        } catch {
          task.guard_state = "unknown";
          task.error = (task.error ? task.error + "; " : "") + "Execution guard state unconfirmed; local recovery required";
          task.status = "failed";
        }
      }
      try { await persist(task, true); }
      finally {
        active.delete(task.id);
        for (const finish of entry.waiters) finish();
      }
      if (task.scratch_dir && scratchRoot) {
        // Best effort: a cleanup failure must not turn a completed task into a failure, and
        // the next completion retries the same rules.
        await cleanupScratch({
          root: scratchRoot,
          task,
          activeIds: [...active.keys()],
          taskDirectory: dir,
          platform: scratchPlatform,
          idPattern,
        }).catch(() => {});
      }
    }
    const failedCount = task.steps.filter((step) => step.failed).length;
    const header = "Task " + task.id + ": " + (task.steps.length - failedCount) +
      "/" + task.steps.length + " steps OK (" + task.status + ")";
    const retained = task.scratch_dir && task.status !== "succeeded"
      ? "Scratch retained: " + task.scratch_dir
      : null;
    return response([header, ...summary, ...exposed, ...(task.error ? [task.error] : []),
      ...(retained ? [retained] : [])].join("\n"),
      task.status !== "succeeded", exposedImages);
  }

  async function run({ steps, stop_on_error = true, max_exposed_chars = 3000,
                        execution = "sync", task_timeout_ms = 1800000, scratch = false }, admission = {}) {
    if (execution === "async" && active.size >= MAX_ACTIVE) {
      return response("Too many active tasks (limit " + MAX_ACTIVE + ")", true);
    }
    if (scratch && !scratchRoot) {
      return response("SCRATCH_UNAVAILABLE: no temporary work area is configured", true);
    }
    const task = {
      id: admission.id || taskId(), mode: execution, status: "queued",
      ...(admission.codex_request_id ? { codex_request_id: admission.codex_request_id } : {}),
      ...(admission.codex_request_id ? { quota_warning_approved: admission.quota_warning_approved === true } : {}),
      requested_kinds: [...new Set(steps.map(step => step.kind))],
      started_at: new Date().toISOString(), total_steps: steps.length,
      current_step: null, active_pid: null, steps: [],
    };
    if (scratch) {
      try {
        task.scratch_dir = await createTaskScratch({
          root: scratchRoot, taskId: task.id, platform: scratchPlatform, idPattern,
        });
      } catch (error) {
        return response("SCRATCH_UNAVAILABLE: " + String(error?.code || error), true);
      }
      // Resolve every relative path before the guard or a worker starts, so a traversal
      // mistake is a clean validation failure rather than an unknown execution.
      try {
        steps = steps.map(step => resolveScratchStep(step, task.scratch_dir, { platform: scratchPlatform }));
      } catch (error) {
        await cleanupScratch({
          root: scratchRoot,
          task: { id: task.id, status: "succeeded", finished_at: new Date().toISOString() },
          activeIds: [...active.keys()], taskDirectory: dir, platform: scratchPlatform, idPattern,
        }).catch(() => {});
        return response("SCRATCH_PATH_ESCAPE: " + String(error?.detail || error?.code || error), true);
      }
    }
    const entry = { task, controller: new AbortController(), abortReason: null, timer: null, waiters: new Set() };
    active.set(task.id, entry);
    try { await persist(task); }
    catch (error) {
      active.delete(task.id);
      for (const finish of entry.waiters) finish();
      throw error;
    }
    if (execution === "async") {
      entry.timer = setTimeout(() => {
        entry.abortReason = "timed_out";
        entry.controller.abort();
      }, task_timeout_ms);
      // Keep the local process alive while the work runs, but not because of the timer alone.
      entry.promise = execute(task, steps, stop_on_error, max_exposed_chars, entry);
      entry.promise.catch(() => {});
      return response("Task " + task.id + ": started (async). Call remote_inspect with task_id to wait and receive the final result. " +
        "Execution timeout " + task_timeout_ms + "ms. Do not poll or narrate repeated waits." +
        (task.scratch_dir ? " Use {{scratch}} or relative paths for temporary files in this task." : ""));
    }
    return await execute(task, steps, stop_on_error, max_exposed_chars, entry);
  }

  async function inspect({ task_id, step_index, max_chars = 10000, action = "inspect",
                           wait_ms = MAX_INSPECT_WAIT_MS }, { signal } = {}) {
    if (!idPattern.test(task_id)) return response("Invalid task id", true);
    if (!Number.isInteger(wait_ms) || wait_ms < 0 || wait_ms > MAX_INSPECT_WAIT_MS) return response("Invalid wait_ms", true);
    const entry = active.get(task_id);
    const loadTask = async () => active.get(task_id)?.task ||
      JSON.parse(await fs.readFile(path.join(dir, task_id + ".json"), "utf8"));
    let task;
    try { task = await loadTask(); }
    catch (error) {
      if (error.code === "ENOENT" && action === "inspect" && explainMissing) {
        const explanation = await explainMissing(task_id);
        if (explanation) return response(explanation);
      }
      return response("Task not found: " + task_id, true);
    }
    if (action === "cancel") {
      if (step_index !== undefined) return response("step_index is not valid with cancel", true);
      if (task.finished_at) return response("Task " + task_id + " is already finished (" +
        (task.status || "finished") + ")");
      const entry = active.get(task_id);
      if (!entry) return response("Task " + task_id +
        " is not active in this MCP process; cannot cancel safely", true);
      if (!entry.controller.signal.aborted) {
        entry.abortReason = "cancelled";
        entry.controller.abort();
      }
      return response("Task " + task_id + ": cancellation requested (best effort); inspect for final state.");
    }
    if (step_index !== undefined && step_index >= (task.total_steps ?? task.steps.length)) {
      return response("Step not found: " + step_index, true);
    }
    await waitForCompletion(entry, wait_ms, signal, () => active.get(task_id) !== entry);
    // Reload after waiting: completion includes final persistence and lock handling,
    // not just the worker's last output or an in-memory finished_at timestamp.
    if (entry) {
      try { task = await loadTask(); }
      catch { return response("Task not found: " + task_id, true); }
    }
    const isActive = active.has(task_id);
    const finished = !!task.finished_at && !isActive;
    let status = task.status || (finished ? (task.steps.some(s => s.failed) ? "failed" : "succeeded") : "unknown");
    if (isActive && task.finished_at) status = "finalizing";
    if (!finished && !isActive) status = task.codex_request_id
      ? "unknown (another process owns task or execution was interrupted; no automatic retry)"
      : "interrupted (MCP process no longer owns task)";
    if (step_index !== undefined) {
      const step = task.steps.find((item) => item.index === step_index);
      if (step && (step.kind !== "codex" || finished)) {
        const loaded = await loadImages(dir, task_id, storedImageRefs(step.result));
        const warning = loaded.unavailable ? "\nWarning: stored images unavailable." : "";
        return response(truncate(compactText(textOf(step.result)), max_chars) + warning, false, loaded.images);
      }
    }
    if (isActive) {
      return response("Task " + task.id + " | " + status + " | wait continues via remote_inspect; do not resubmit.");
    }
    const warnings = [
      ...(task.error ? ["Error: " + task.error] : []),
      ...(task.guard_state === "unknown" ? ["Execution lock retained/unconfirmed; local inspected recovery required"] : []),
      ...(task.execution_unknown && !task.recovery ? ["Execution outcome unknown; do not automatically retry"] : []),
      ...(task.recovery ? ["Recovered by local approval " + task.recovery.audit_id + "; original outcome not upgraded to success"] : []),
      ...(task.scratch_dir && task.status !== "succeeded" ? ["Scratch retained: " + task.scratch_dir] : []),
    ];
    if (finished && task.steps.length === 1 && task.steps[0].kind === "codex") {
      const header = ["Task " + task.id + " | " + status, ...warnings].join("\n");
      const output = compactText(textOf(task.steps[0].result));
      return response(header + "\n" + truncate(output, max_chars),
        task.status !== "succeeded" || task.steps[0].failed === true);
    }
    const loaded = await loadImages(dir, task_id, finished
      ? task.steps.filter(step => step.expose === true).flatMap(step => storedImageRefs(step.result)) : []);
    const lines = [
      "Task " + task.id + " | " + status + " | " + task.steps.length + "/" +
        (task.total_steps ?? task.steps.length) + " steps finished",
      ...(task.current_step !== null && task.current_step !== undefined ?
        ["Current step: " + (task.current_step + 1) + (task.active_pid ? " (PID " + task.active_pid + ")" : "")] : []),
      ...(active.get(task_id)?.controller.signal.aborted ? ["Cancellation/timeout requested"] : []),
      ...task.steps.map((step) =>
        (step.index + 1) + ". [" + (step.status || (step.failed ? "failed" : "succeeded")) + "] " +
        (step.label ? step.label + ": " : "") + step.summary),
      ...warnings,
    ];
    const warning = loaded.unavailable ? "\nWarning: stored images unavailable." : "";
    return response(truncate(lines.join("\n"), max_chars) + warning, false, loaded.images);
  }

  return { run, inspect, coordinationEnabled: guard.enabled };
}
