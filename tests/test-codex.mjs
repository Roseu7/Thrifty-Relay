import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCodexAdapter } from "../src/codex/adapter.mjs";
import { createTaskManager } from "../src/mcp/task-manager.mjs";
import { testCodexDiagnostics } from "./test-codex-diagnostics.mjs";
import { fixtureQuotaReader } from "./quota-fixture.mjs";

const parent = path.resolve(process.env.THRIFTYRELAY_TEST_ROOT || os.tmpdir());
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "remote-codex-phase2-"));
const isolation = pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href;
const missingPolicy = path.join(parent, "missing-policy.json");
const checks = [];
testCodexDiagnostics();
checks.push("diagnostics_enum_allowlist_and_no_secrets");
const evidence = { root, checks, live: process.argv.includes("--live") || process.argv.includes("--live-cancel") };
const text = result => result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
const taskId = () => `task_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 6)}`;
const idPattern = /^task_[a-z0-9]+_[a-z0-9]{6}$/;
const idOf = result => { assert(!result.isError, text(result)); const id = text(result).match(idPattern); return id?.[0] || text(result).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0]; };
const waitFor = async check => { const end = Date.now() + 12000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 60)); } throw new Error("Fixture wait timed out"); };
const exists = file => fs.stat(file).then(() => true, () => false);
const prior = { home: process.env.CODEX_HOME, workspace: process.env.THRIFTYRELAY_CODEX_WORKSPACE,
  temp: process.env.THRIFTYRELAY_TEMP_WORKSPACE };
const home = path.join(root, "auth");
await fs.mkdir(home);
await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-not-for-network" } }));
process.env.CODEX_HOME = home;
process.env.OPENAI_API_KEY = "sk-test-key-not-for-network";
process.env.CODEX_API_KEY = "sk-test-key-not-for-network";
process.env.OPENAI_BASE_URL = "https://invalid.example";

async function fixture(name) {
  const base = path.join(root, name), cwd = path.join(base, "workspace"), dir = path.join(base, "tasks");
  await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(dir);
  process.env.THRIFTYRELAY_CODEX_WORKSPACE = cwd;
  const adapter = createCodexAdapter({ dir, taskId, workerFile: new URL("./test-codex-worker.mjs", import.meta.url),
    quotaReader: fixtureQuotaReader, configFile: path.join(dir, "fixture-config.json") });
  const manager = createTaskManager({ dir, taskId, idPattern, textOf: text,
    compactText: String, truncate: (s, n) => s.slice(0, n), redactHistory: String,
    executeStep: (step, context) => adapter.execute(step, context) });
  const args = (prompt = "ok", extra = {}) => ({ execution: "async", task_timeout_ms: 30000,
    steps: [{ kind: "codex", cwd, permissions: "full-access", request_id: randomUUID(), prompt, ...extra }] });
  const submit = value => adapter.submit(value, manager.run);
  const done = async id => { await waitFor(async () => (JSON.parse(await fs.readFile(path.join(dir, id + ".json")))).finished_at); return JSON.parse(await fs.readFile(path.join(dir, id + ".json"))); };
  return { cwd, dir, adapter, manager, args, submit, done };
}

try {
  const f = await fixture("dedup");
  const request = f.args("slow");
  const pair = await Promise.all([f.submit(request), f.submit(request)]);
  assert.equal(idOf(pair[0]), idOf(pair[1]));
  assert(pair.some(result => /duplicate/.test(text(result))));
  const id = idOf(pair[0]);
  const waited = await f.manager.inspect({ task_id: id });
  assert(!waited.isError);
  assert.match(text(waited), /\| succeeded\n/);
  const combined = JSON.parse(text(waited).split("\n").slice(1).join("\n"));
  assert(combined.conversation_id && combined.answer);
  assert.equal(Object.hasOwn(combined, "usage"), false, "unavailable fixture usage must not be invented");
  const task = await f.done(id);
  assert.equal(task.status, "succeeded");
  assert.equal(await fs.readFile(path.join(f.cwd, "invocations.txt"), "utf8"), "run\n");
  const env = JSON.parse(await fs.readFile(path.join(f.cwd, "child-env.json")));
  assert(Object.values(env).every(value => value === false));
  const changed = structuredClone(request); changed.steps[0].prompt = "changed";
  assert(text(await f.submit(changed)).includes("CODEX_REQUEST_ID_CONFLICT"));
  const reloaded = createCodexAdapter({ dir: f.dir, taskId, quotaReader: fixtureQuotaReader,
    configFile: path.join(f.dir, "fixture-config.json") });
  assert.equal(idOf(await reloaded.submit(request, () => { throw new Error("MUST NOT RUN"); })), id);
  checks.push("durable_request_before_worker_write", "simultaneous_duplicate_once", "conflicting_request_id_rejected", "dedup_after_adapter_restart", "child_environment_filtered");
  checks.push("one_inspect_waits_for_fixture_worker_and_returns_final_codex_output");

  const first = JSON.parse(text(await f.manager.inspect({ task_id: id, step_index: 0 })));
  const next = await f.done(idOf(await f.submit(f.args("long", { conversation_id: first.conversation_id }))));
  const long = JSON.parse(text(next.steps[0].result));
  assert(long.truncated && JSON.stringify(long).length <= 10000);
  assert(!long.answer.includes("abcdefghijklmnop"));
  assert.equal(long.conversation_id, first.conversation_id);
  for (const [extra, code] of [[{ readOnly: true }, "CODEX_READONLY_UNAVAILABLE"],
    [{ model: "unknown-model" }, "CODEX_MODEL_UNSUPPORTED"], [{ permissions: undefined }, "CODEX_EXPLICIT_FULL_ACCESS_REQUIRED"],
    [{ cwd: root }, "CODEX_WORKSPACE_NOT_ALLOWED"], [{ conversation_id: "cx_" + "a".repeat(32) }, "CODEX_CONVERSATION_NOT_OWNED"]]) {
    const result = await f.submit(f.args("ok", extra));
    // Conversation ownership is checked after durable admission, inside the task.
    if (extra.conversation_id) assert(text((await f.done(idOf(result))).steps[0].result).includes(code));
    else assert(result.isError && text(result).includes(code), code);
  }
  checks.push("normal_thread_continuation", "long_answer_valid_json", "readonly_rejected", "unknown_model_rejected", "explicit_permissions_required", "cwd_allowlist", "foreign_thread_rejected");

  // Temporary work is a second cwd target, but only a subdirectory of the registered root:
  // the root itself stays out of the allowlist, and the sandbox still comes from the tier.
  const scratchRoot = path.join(root, "scratch");
  const scratchCwd = path.join(scratchRoot, "task_scratch_abc123");
  await fs.mkdir(scratchCwd, { recursive: true });
  // The fixture worker proves a durable claim exists before running by reading the task store
  // relative to its cwd. Give the scratch tree the same shape so the check is not skipped.
  const scratchClaims = path.join(scratchRoot, "tasks", "codex", "requests");
  await fs.mkdir(scratchClaims, { recursive: true });
  await fs.writeFile(path.join(scratchClaims, "fixture.json"), JSON.stringify({ state: "running" }));
  process.env.THRIFTYRELAY_TEMP_WORKSPACE = scratchRoot;
  const scratchBase = f.args("ok");
  const scratchSubmit = await f.submit({ ...scratchBase,
    steps: [{ ...scratchBase.steps[0], cwd: scratchCwd, request_id: randomUUID() }] });
  assert(!scratchSubmit.isError, text(scratchSubmit));
  const scratchTask = await f.done(idOf(scratchSubmit));
  assert.equal(scratchTask.status, "succeeded");
  assert.equal(await fs.readFile(path.join(scratchCwd, "invocations.txt"), "utf8"), "run\n");
  const rootSubmit = await f.submit({ ...scratchBase,
    steps: [{ ...scratchBase.steps[0], cwd: scratchRoot, request_id: randomUUID() }] });
  assert(rootSubmit.isError && text(rootSubmit).includes("CODEX_WORKSPACE_NOT_ALLOWED"));
  const scratchFlag = await f.submit({ ...scratchBase, scratch: true,
    steps: [{ ...scratchBase.steps[0], cwd: scratchCwd, request_id: randomUUID() }] });
  assert(scratchFlag.isError && text(scratchFlag).includes("CODEX_SCRATCH_UNSUPPORTED"));
  checks.push("codex_scratch_cwd_allows_only_a_subdirectory");
  const corrupt = f.args();
  const corruptFile = path.join(f.dir, "codex", "requests", createHash("sha256").update(corrupt.steps[0].request_id).digest("hex") + ".json");
  await fs.writeFile(corruptFile, "{");
  const invocationCount = await fs.readFile(path.join(f.cwd, "invocations.txt"), "utf8");
  assert(text(await f.submit(corrupt)).includes("CODEX_REQUEST_RECORD_INVALID"));
  assert.equal(await fs.readFile(path.join(f.cwd, "invocations.txt"), "utf8"), invocationCount);
  checks.push("corrupt_claim_never_overwritten_or_reexecuted");

  const guardTransport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", isolation, path.join(import.meta.dirname, "..", "index.mjs")], cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, THRIFTYRELAY_TASK_DIR: path.join(root, "protocol-tasks"),
      THRIFTYRELAY_TEST_POLICY_FILE: missingPolicy,
      THRIFTYRELAY_CODEX_WORKSPACE: f.cwd }, stderr: "pipe" });
  guardTransport.stderr?.resume();
  const guardClient = new Client({ name: "codex-protocol-guards", version: "1" }, { capabilities: {} });
  try {
    await guardClient.connect(guardTransport);
    const tools = (await guardClient.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name), ["health", "remote_task", "open_approval", "pending_approvals", "approve_task", "decline_task", "approval_step", "remote_inspect", "open_settings", "settings_update"]);
    const readonly = f.args("ok", { readOnly: true });
    const denied = await guardClient.callTool({ name: "remote_task", arguments: readonly });
    assert(denied.isError && text(denied).includes("CODEX_READONLY_UNAVAILABLE"));
    const sync = await guardClient.callTool({ name: "remote_task", arguments: { ...f.args(), execution: "sync" } });
    assert(sync.isError && text(sync).includes("CODEX_REQUIRES_ONE_ASYNC_STEP"));
    const ordinary = await guardClient.callTool({ name: "remote_task", arguments: { steps: [
      { kind: "read", path: path.join(import.meta.dirname, "..", "package.json"), length: 2 }] } });
    assert(!ordinary.isError);
    assert(!await exists(path.join(root, "protocol-tasks", "codex")));
    checks.push("public_readonly_rejected_without_dispatch", "public_codex_requires_async", "public_tools_remain_five", "ordinary_remote_read_unchanged");
  } finally { await guardClient.close(); }

  const c = await fixture("cancel");
  const pending = c.args("hang"), running = idOf(await c.submit(pending));
  await waitFor(() => exists(path.join(c.cwd, "grandchild.pid")));
  const competitor = createCodexAdapter({ dir: c.dir, taskId, workerFile: new URL("./test-codex-worker.mjs", import.meta.url),
    quotaReader: fixtureQuotaReader, configFile: path.join(c.dir, "fixture-config.json") });
  const other = await competitor.submit(c.args(), c.manager.run);
  assert(text((await c.done(idOf(other))).steps[0].result).includes("CODEX_EXECUTION_LOCKED"));
  await c.manager.inspect({ task_id: running, action: "cancel" });
  const cancelled = await c.done(running);
  assert.equal(cancelled.status, "cancelled");
  const stopped = JSON.parse(text(cancelled.steps[0].result));
  assert.equal(stopped.lock_retained, false);
  assert.equal(stopped.execution_state, "effects_unknown");
  const ticks = await fs.readFile(path.join(c.cwd, "ticks.txt"), "utf8").catch(() => "");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await fs.readFile(path.join(c.cwd, "ticks.txt"), "utf8").catch(() => ""), ticks);
  assert(!await exists(path.join(c.dir, "codex", "active.lock")));
  assert.equal(idOf(await c.submit(pending)), running);
  checks.push("shared_store_execution_lock", "cancel_kills_owned_process_tree", "cancel_effects_unknown_no_replay");

  const timeoutArgs = { ...c.args("hang"), task_timeout_ms: 600 };
  const timed = await c.done(idOf(await c.submit(timeoutArgs)));
  assert.equal(timed.status, "timed_out");
  checks.push("timeout_uses_cancellation_path");

  const b = await fixture("crash");
  const crashRequest = b.args("crash");
  const crashedId = idOf(await b.submit(crashRequest));
  const crashed = await b.done(crashedId);
  assert.equal(crashed.status, "failed");
  assert.equal(JSON.parse(text(crashed.steps[0].result)).lock_retained, true);
  assert(await exists(path.join(b.dir, "codex", "active.lock")));
  assert.equal(idOf(await b.submit(crashRequest)), crashedId);
  const afterCrash = await b.done(idOf(await b.submit(b.args())));
  assert(text(afterCrash.steps[0].result).includes("CODEX_EXECUTION_LOCKED"));
  checks.push("abnormal_exit_retains_lock", "abnormal_exit_no_replay", "new_request_blocked_after_unknown_execution");

  const d = await fixture("diagnostic");
  const diagnosticId = idOf(await d.submit(d.args("diagnostic-fail")));
  const diagnosticTask = await d.done(diagnosticId);
  const diagnosticResult = JSON.parse(text(diagnosticTask.steps[0].result));
  assert.equal(diagnosticTask.status, "failed");
  assert.equal(diagnosticResult.lock_retained, true);
  assert.equal(diagnosticResult.error, "CODEX_TURN_FAILED");
  assert.deepEqual(diagnosticResult.diagnostic, {
    origin: "sdk_event", phase: "turn_failed", category: "network",
    thread_started: true, events_seen: 3
  });
  assert(!JSON.stringify(diagnosticResult).includes("fixture-secret-token"));
  assert(!JSON.stringify(diagnosticResult).includes("sk-test-key-not-for-network"));
  checks.push("failure_diagnostic_persisted_without_raw_sdk_text");

  const x = await fixture("diagnostic-exit");
  const exitId = idOf(await x.submit(x.args("diagnostic-exit")));
  const exitResult = JSON.parse(text((await x.done(exitId)).steps[0].result));
  assert.equal(exitResult.lock_retained, true);
  assert.deepEqual(exitResult.diagnostic, {
    origin: "worker_exit", phase: "worker_exit", category: "worker_exit",
    thread_started: true, worker_exit_code: 21
  });
  checks.push("abnormal_exit_diagnostic_and_lock_retention");


  const r = await fixture("restart"), restartArgs = r.args("slow");
  const host = fork(new URL("./test-codex-host.mjs", import.meta.url), [], { windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const accepted = new Promise(resolve => host.once("message", resolve));
    host.send({ dir: r.dir, args: restartArgs });
    const runningId = idOf(await accepted);
    await waitFor(() => exists(path.join(r.cwd, "invocations.txt")));
    assert.equal(idOf(await r.submit(restartArgs)), runningId);
    const competingId = idOf(await r.submit(r.args()));
    assert(text((await r.done(competingId)).steps[0].result).includes("CODEX_EXECUTION_LOCKED"));
    const exited = new Promise(resolve => host.once("exit", resolve));
    host.kill(); await exited;
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert(text(await r.manager.inspect({ task_id: runningId })).includes("unknown"));
    assert.equal(idOf(await r.submit(restartArgs)), runningId);
    assert(await exists(path.join(r.dir, "codex", "active.lock")));
    checks.push("cross_process_duplicate_once", "cross_process_conflict_rejected", "host_crash_retains_lock_and_unknown_state", "host_crash_duplicate_never_resubmits");
  } finally { if (host.exitCode === null) host.kill(); }

  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "dummy" }));
  assert(text(await r.submit(r.args())).includes("CODEX_CHATGPT_AUTH_REQUIRED"));
  checks.push("api_auth_rejected");

  if (evidence.live) {
    // Restore the real existing ChatGPT sign-in only for the explicitly opted-in live test.
    if (prior.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior.home;
    const base = path.join(root, "live"), cwd = path.join(base, "workspace"), dir = path.join(base, "tasks");
    await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(dir);
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "Operate only in this validation directory. Never use MCP or PC/browser actions in this test. Never read secrets. Do not delegate.\n");
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", isolation, path.join(import.meta.dirname, "..", "index.mjs")],
      cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, THRIFTYRELAY_CODEX_WORKSPACE: cwd, THRIFTYRELAY_TASK_DIR: dir,
        THRIFTYRELAY_TEST_POLICY_FILE: missingPolicy }, stderr: "pipe" });
    transport.stderr?.resume();
    const client = new Client({ name: "codex-phase2-test", version: "1" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      evidence.tool_names = tools.map(tool => tool.name); evidence.tools_bytes = Buffer.byteLength(JSON.stringify(tools));
      evidence.instructions_bytes = Buffer.byteLength(client.getInstructions() || "");
      assert.deepEqual(evidence.tool_names, ["health", "remote_task", "open_approval", "pending_approvals", "approve_task", "decline_task", "approval_step", "remote_inspect", "open_settings", "settings_update"]);
      const step = { kind: "codex", cwd, permissions: "full-access", task_type: "code", model: "gpt-6.1-sol", reasoning_effort: "high", request_id: randomUUID(),
        prompt: 'Create exactly one file sum.mjs exporting function sum(a,b) returning a+b. Run a Node assertion for sum(2,3) === 5. Do not modify AGENTS.md or create any other files. Reply briefly with the result.' };
      const runLive = async current => {
        const args = { execution: "async", task_timeout_ms: 300000, steps: [current] };
        const started = performance.now(), accepted = await client.callTool({ name: "remote_task", arguments: args });
        const id = idOf(accepted); assert(id);
        const acceptedMs = Math.round(performance.now() - started);
        assert(acceptedMs < 5000);
        assert.equal(idOf(await client.callTool({ name: "remote_task", arguments: args })), id);
        const healthStart = performance.now(); await client.callTool({ name: "health", arguments: {} });
        const healthMs = Math.round(performance.now() - healthStart);
        const end = Date.now() + 320000; let status;
        while (Date.now() < end) {
          status = text(await client.callTool({ name: "remote_inspect", arguments: { task_id: id } }));
          if (/\| (succeeded|failed|cancelled|timed_out)/.test(status)) break;
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        const result = JSON.parse(text(await client.callTool({ name: "remote_inspect", arguments: { task_id: id, step_index: 0 } })));
        assert(status.includes("| succeeded |"), status + JSON.stringify(result));
        const conv = JSON.parse(await fs.readFile(path.join(dir, "codex", result.conversation_id + ".json")));
        const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
        const rollout = (await fs.readdir(sessions, { recursive: true })).find(file => file.endsWith(conv.thread_id + ".jsonl"));
        const rows = (await fs.readFile(path.join(sessions, rollout), "utf8")).trim().split("\n").map(line => JSON.parse(line));
        const runtime = rows.filter(row => row.type === "turn_context").at(-1).payload;
        assert.equal(runtime.model, "gpt-6.1-sol"); assert.equal(runtime.effort, "high");
        assert.equal(runtime.sandbox_policy.type, "danger-full-access");
        assert.equal(rows.find(row => row.type === "session_meta").payload.model_provider, "openai");
        (evidence.turns ||= []).push({ task_id: id, conversation_id: conv.id, thread_id: conv.thread_id, accepted_ms: acceptedMs,
          health_ms: healthMs, elapsed_ms: Math.round(performance.now() - started), model: runtime.model, effort: runtime.effort,
          sandbox: runtime.sandbox_policy.type, provider: "openai" });
        console.log("LIVE", JSON.stringify(evidence.turns.at(-1)));
        return result;
      };
      if (process.argv.includes("--live-cancel")) {
        const cancelStep = { ...step, prompt: 'This is an owner-authorized cancellation test. Start exactly one Node process in this directory. It must write cancel-started.json with JSON.stringify({pid:process.pid}), then wait for 60 seconds using setTimeout. Do not create other files, use MCP, delegate or modify configuration. Keep waiting/polling the command until it exits; do not return early. The owner will cancel this task externally.' };
        const args = { execution: "async", task_timeout_ms: 180000, steps: [cancelStep] };
        const accepted = await client.callTool({ name: "remote_task", arguments: args });
        const cancelId = idOf(accepted); assert(cancelId);
        const canary = path.join(cwd, "cancel-started.json");
        const end = Date.now() + 150000;
        while (!await exists(canary) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 500));
        assert(await exists(canary), "SDK cancellation command did not start");
        const { pid } = JSON.parse(await fs.readFile(canary, "utf8"));
        const cancelStart = performance.now();
        await client.callTool({ name: "remote_inspect", arguments: { task_id: cancelId, action: "cancel" } });
        let finished;
        await waitFor(async () => {
          finished = JSON.parse(await fs.readFile(path.join(dir, cancelId + ".json"), "utf8"));
          return !!finished.finished_at;
        });
        assert.equal(finished.status, "cancelled");
        const cancelled = JSON.parse(text(finished.steps[0].result));
        assert.equal(cancelled.lock_retained, false);
        assert.equal(cancelled.execution_state, "effects_unknown");
        let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
        assert.equal(alive, false, "owned Node canary process remained alive");
        assert.equal(idOf(await client.callTool({ name: "remote_task", arguments: args })), cancelId);
        evidence.cancellation = { task_id: cancelId, elapsed_ms: Math.round(performance.now() - cancelStart),
          node_canary_exited: true, lock_retained: false, execution_state: cancelled.execution_state };
        checks.push("live_sdk_cancel_owned_tree", "live_cancel_no_reexecution");
      } else {
      const result = await runLive(step);
      const { sum } = await import(new URL("file:///" + path.join(cwd, "sum.mjs").replaceAll("\\", "/")));
      assert.equal(sum(2, 3), 5);
      const before = await fs.readFile(path.join(cwd, "sum.mjs"), "utf8");
      const resumed = await runLive({ ...step, request_id: randomUUID(), conversation_id: result.conversation_id,
        prompt: 'Without changing files or calling tools, state which file and function you created in the preceding turn.' });
      assert(resumed.answer.includes("sum.mjs") && /\bsum\b/.test(resumed.answer));
      assert.equal(await fs.readFile(path.join(cwd, "sum.mjs"), "utf8"), before);
      checks.push("live_sol_high_file_edit_and_node_assertion", "live_thread_continuation", "live_duplicate_returns_original_task", "public_tools_remain_five");
      }
    } finally { await client.close(); }
  }
  evidence.passed = true;
} finally {
  if (prior.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior.home;
  if (prior.workspace === undefined) delete process.env.THRIFTYRELAY_CODEX_WORKSPACE; else process.env.THRIFTYRELAY_CODEX_WORKSPACE = prior.workspace;
  if (prior.temp === undefined) delete process.env.THRIFTYRELAY_TEMP_WORKSPACE; else process.env.THRIFTYRELAY_TEMP_WORKSPACE = prior.temp;
  if (process.env.THRIFTYRELAY_TEST_EVIDENCE) await fs.writeFile(process.env.THRIFTYRELAY_TEST_EVIDENCE, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
