import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { createTaskManager, MAX_INSPECT_WAIT_MS } from "../src/mcp/task-manager.mjs";

const text = result => result.content?.map(item => item.text || "").join("\n") || "";
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

export async function testTaskWaiting() {
  assert.equal(MAX_INSPECT_WAIT_MS, 120000);
  const parent = path.resolve(process.env.THRIFTYRELAY_TEST_ROOT || os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, "task-wait-"));
  const checks = [];
  const fixtures = [];
  const output = { answer: "fixture answer", conversation_id: "cx_fixture", usage: { input_tokens: 3, output_tokens: 2 },
    review: { summary: { complete: true }, path: "fixture-review.json" } };
  async function fixture() {
    const dir = path.join(root, randomUUID());
    await fs.mkdir(dir);
    const started = deferred(), release = deferred();
    let context, executions = 0;
    const manager = createTaskManager({ dir,
      taskId: () => "task_wait_" + randomUUID().slice(0, 6), idPattern: /^task_[a-z0-9]+_[a-z0-9]{6}$/,
      textOf: text, compactText: String, redactHistory: String,
      truncate: (value, limit) => value.length <= limit ? value : value.slice(0, limit) + "[TRUNCATED]",
      executeStep: async (_step, current) => {
        executions++;
        context = current;
        started.resolve();
        const result = await Promise.race([
          release.promise,
          new Promise(resolve => current.signal.addEventListener("abort", () => resolve({
            failed: true, status: current.reason(), execution_unknown: true,
            summary: "fixture stopped", result: { content: [{ type: "text", text: "fixture cancelled" }] },
          }), { once: true })),
        ]);
        if (result instanceof Error) throw result;
        return result || { summary: "codex: PASS", result: { content: [{ type: "text", text: JSON.stringify(output) }] } };
      },
    });
    const id = text(await manager.run({ execution: "async", steps: [{ kind: "codex" }], task_timeout_ms: 10000 }))
      .match(/task_[a-z0-9]+_[a-z0-9]{6}/)[0];
    await started.promise;
    const done = () => manager.inspect({ task_id: id });
    const item = { dir, manager, id, release, done, get context() { return context; }, get executions() { return executions; } };
    fixtures.push(item);
    return item;
  }
  try {
    {
      const f = await fixture();
      let settled = false;
      const waiting = f.done().then(result => { settled = true; return result; });
      await tick();
      assert.equal(settled, false, "default inspect must wait rather than immediately poll");
      const completedEarly = f.manager.inspect({ task_id: f.id });
      f.release.resolve();
      const result = await waiting;
      assert.match(text(await completedEarly), /fixture answer/,
        "default inspect must return on completion without waiting for the 120s deadline");
      assert(!result.isError);
      assert.match(text(result), /\| succeeded\n/);
      assert.deepEqual(JSON.parse(text(result).split("\n").slice(1).join("\n")), output);
      const record = JSON.parse(await fs.readFile(path.join(f.dir, f.id + ".json"), "utf8"));
      assert(record.finished_at, "the combined result must already be durably finished");
      assert.equal(record.status, "succeeded");
      assert.equal(f.executions, 1);
      assert.equal(text(await f.manager.inspect({ task_id: f.id, step_index: 0 })), JSON.stringify(output));
      checks.push("one_wait_returns_durable_codex_answer_review_and_usage");
    }
    {
      const f = await fixture();
      f.release.resolve();
      await f.done();
      const started = Date.now();
      const result = await f.manager.inspect({ task_id: f.id });
      assert.match(text(result), /fixture answer/);
      assert(Date.now() - started < 1000, "a persisted completed task must not wait for the deadline");
      checks.push("completed_task_does_not_wait_after_record_load");
    }
    {
      const f = await fixture();
      const full = { ...output, answer: "" };
      full.answer = "x".repeat(10000 - JSON.stringify(full).length);
      const serialized = JSON.stringify(full);
      assert.equal(serialized.length, 10000);
      f.release.resolve({ summary: "codex: PASS", result: { content: [{ type: "text", text: serialized }] } });
      const result = await f.done();
      assert.deepEqual(JSON.parse(text(result).split("\n").slice(1).join("\n")), full);
      checks.push("task_header_does_not_truncate_a_full_size_codex_result_or_its_review");
    }
    {
      const f = await fixture();
      for (const args of [{ wait_ms: 10 }, { wait_ms: 0, step_index: 0 }]) {
        const result = await f.manager.inspect({ task_id: f.id, ...args });
        assert(!result.isError, "a valid running step is not an error");
        assert.match(text(result), /\| running \|/);
        assert(text(result).length < 200);
        assert.equal(f.context.signal.aborted, false);
      }
      assert((await f.manager.inspect({ task_id: f.id, step_index: 1 })).isError);
      for (const wait_ms of [-1, MAX_INSPECT_WAIT_MS + 1, 1.5, NaN]) {
        assert((await f.manager.inspect({ task_id: f.id, wait_ms })).isError);
      }
      f.release.resolve();
      assert.match(text(await f.done()), /fixture answer/);
      assert.equal(f.executions, 1, "wait expiry must not cancel or redispatch the worker");
      checks.push("bounded_wait_and_immediate_snapshot_leave_work_running_without_error");
    }
    {
      const f = await fixture(), request = new AbortController();
      const first = f.manager.inspect({ task_id: f.id }, { signal: request.signal });
      let secondSettled = false;
      const second = f.done().then(result => { secondSettled = true; return result; });
      await tick();
      assert.equal(getEventListeners(request.signal, "abort").length, 1);
      request.abort();
      assert.match(text(await first), /\| running \|/);
      assert.equal(getEventListeners(request.signal, "abort").length, 0);
      assert.equal(f.context.signal.aborted, false);
      assert.equal(secondSettled, false);
      f.release.resolve();
      assert.match(text(await second), /fixture answer/);
      assert.equal(f.executions, 1);
      checks.push("aborting_one_wait_cleans_its_listener_without_cancelling_work_or_other_waiters");
    }
    {
      const f = await fixture();
      const waiting = f.done();
      const cancelled = await f.manager.inspect({ task_id: f.id, action: "cancel" });
      assert.match(text(cancelled), /cancellation requested/);
      const result = await waiting;
      assert(result.isError);
      assert.match(text(result), /\| cancelled/);
      assert.match(text(result), /Execution outcome unknown; do not automatically retry/);
      assert.equal(f.context.signal.aborted, true);
      checks.push("explicit_task_cancel_is_immediate_and_wakes_waiters_with_final_failure");
    }
    {
      const f = await fixture();
      f.release.resolve(new Error("FIXTURE_FAILURE"));
      const result = await f.done();
      assert(result.isError);
      assert.match(text(result), /\| failed/);
      assert.match(text(result), /FIXTURE_FAILURE/);
      assert.match(text(result), /Execution outcome unknown; do not automatically retry/);
      checks.push("combined_result_preserves_failures_and_unknown_side_effect_warnings");
    }
    {
      const f = await fixture();
      const waiting = f.done();
      const file = path.join(f.dir, f.id + ".json");
      await fs.rename(file, file + ".saved");
      await fs.mkdir(file);
      f.release.resolve();
      const result = await waiting;
      assert(result.isError);
      assert.match(text(result), /Task not found/);
      checks.push("failed_final_persistence_never_returns_in_memory_success");
    }
    {
      const f = await fixture();
      f.release.resolve();
      await f.done();
      const id = "task_external_abcdef";
      await fs.writeFile(path.join(f.dir, id + ".json"), JSON.stringify({ id, status: "running", codex_request_id: "fixture",
        steps: [], total_steps: 1 }));
      const result = await f.manager.inspect({ task_id: id });
      assert.match(text(result), /unknown \(another process owns task/);
      assert(!text(result).includes("wait continues"));
      checks.push("unowned_persisted_task_is_reported_unknown_without_waiting_or_replay");
    }
    console.log("TASK WAIT OK " + JSON.stringify({ checks }));
  } finally {
    for (const f of fixtures) {
      f.release.resolve();
      await f.done();
    }
    const relative = path.relative(parent, root);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
}
