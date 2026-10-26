import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createExecutionGuard, exists, lockSnapshot } from "../src/mcp/execution-guard.mjs";
import { createTaskManager } from "../src/mcp/task-manager.mjs";
import { createCodexAdapter } from "../src/codex/adapter.mjs";
import { inspectRecovery, recoverExecution } from "../src/mcp/recovery.mjs";
import { writeRecord } from "../src/mcp/task-storage.mjs";
import { fixtureQuotaReader } from "./quota-fixture.mjs";

const parent = path.resolve(process.env.THRIFTYRELAY_TEST_ROOT || os.tmpdir());
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "remote-phase3-"));
const cwd = path.join(root, "workspace"), dir = path.join(root, "tasks"), home = path.join(root, "auth");
await Promise.all([fs.mkdir(cwd), fs.mkdir(dir), fs.mkdir(home)]);
await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-only-no-network" } }));
process.env.CODEX_HOME = home;
process.env.THRIFTYRELAY_CODEX_WORKSPACE = cwd;
const taskId = () => `task_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
const text = value => value.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
const idOf = result => { assert(!result.isError, text(result)); return text(result).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0]; };
const waitFor = async check => { const end = Date.now() + 25000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 60)); } throw new Error("wait timed out"); };
const checks = [], evidence = { root, checks };
const guard = createExecutionGuard({ dir });
const holdId = taskId();
let held = await guard.acquire({ task_id: holdId, kind: "codex", cwd });
await writeRecord(path.join(dir, holdId + ".json"), { id: holdId, status: "running", steps: [], total_steps: 1 });
const original = path.join(cwd, "original.txt");
await fs.writeFile(original, "original\n");

const transport = new StdioClientTransport({ command: process.execPath,
  args: ["--import", pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href, path.join(import.meta.dirname, "..", "index.mjs")],
  cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, THRIFTYRELAY_TASK_DIR: dir,
    THRIFTYRELAY_TEST_POLICY_FILE: path.join(root, "missing-policy.json"),
    THRIFTYRELAY_CODEX_WORKSPACE: "" }, stderr: "pipe" });
transport.stderr?.resume();
const client = new Client({ name: "phase3-conflict-tests", version: "1" }, { capabilities: {} });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  evidence.tools_bytes = Buffer.byteLength(JSON.stringify(tools));
  evidence.instructions_bytes = Buffer.byteLength(client.getInstructions() || "");
  assert.deepEqual(tools.map(tool => tool.name), ["health", "remote_task", "open_approval", "pending_approvals", "approve_task", "decline_task", "approval_step", "remote_inspect", "open_settings", "settings_update"]);
  evidence.health = text(await client.callTool({ name: "health", arguments: {} }));
  assert(/build=[a-f0-9]{12}; source=current/.test(evidence.health));
  assert(evidence.health.includes("codex=disabled; writers=coordinated"));
  checks.push("persistent_coordination_covers_wrapper_without_codex_environment");
  const canary = path.join(cwd, "must-not-exist.txt");
  for (const step of [
    { kind: "run", command: `Set-Content -LiteralPath '${canary}' -Value unsafe` },
    { kind: "write", path: canary, content: "unsafe" },
    { kind: "edit", file_path: original, old_string: "original", new_string: "changed" },
    { kind: "patch", files: [{ path: original, edits: [{ old_string: "original", new_string: "changed" }] }] },
    { kind: "call", tool: "write_file", arguments: { path: canary, content: "unsafe" } },
    { kind: "code", code: `await tools.run({command:${JSON.stringify(`Set-Content -LiteralPath '${canary}' -Value unsafe`)}});` },
  ]) {
    const blocked = await client.callTool({ name: "remote_task", arguments: { steps: [step] } });
    assert(blocked.isError && text(blocked).includes("REMOTE_EXECUTION_LOCKED"), step.kind + text(blocked));
    assert(!await exists(canary)); assert.equal(await fs.readFile(original, "utf8"), "original\n");
    checks.push("codex_blocks_remote_" + step.kind);
  }
  for (const step of [{ kind: "read", path: original }, { kind: "search", path: cwd, pattern: "original", max_results: 2 }]) {
    const result = await client.callTool({ name: "remote_task", arguments: { steps: [step] } });
    assert(!result.isError, text(result)); checks.push("reader_available_during_codex_" + step.kind);
  }
} finally { await client.close(); }

const approvalFor = async task_id => ({ task_id, lock_sha256: (await lockSnapshot(guard.active)).sha256,
  owned_processes_stopped: true, untracked_processes_reviewed: true, files_reviewed: true, external_operations_reviewed: true,
  approved_by: "test-fixture-only", approval_reference: "synthetic fixture approval; never production authorization",
  process_evidence: "All owned fixture workers have stopped; no detached fixture operations remain.",
  file_evidence: "Only the isolated validation directory was inspected against its fixture baseline.",
  external_evidence: "The fixture used no external applications, network or third-party services." });
try {
  let approval = await approvalFor(holdId);
  await assert.rejects(recoverExecution({ dir, approval, confirm: async () => true }), { code: "REMOTE_OWNER_TASK_STILL_ACTIVE" });
  checks.push("live_owner_task_cannot_be_recovered");
  await held.release();
  held = null;

  let releaseWriter;
  let writerStarted = false;
  const adapter = createCodexAdapter({ dir, taskId, workerFile: new URL("./test-codex-worker.mjs", import.meta.url),
    quotaReader: fixtureQuotaReader, configFile: path.join(dir, "fixture-config.json") });
  const manager = createTaskManager({ dir, taskId, idPattern: /^task_[a-z0-9]+_[a-z0-9]{6}$/,
    textOf: text, compactText: String, truncate: (s, n) => s.slice(0, n), redactHistory: String,
    executeStep: async (step, context) => {
      if (step.kind === "codex") return adapter.execute(step, context);
      if (step.kind === "write") {
        writerStarted = true; await new Promise(resolve => { releaseWriter = resolve; });
        return { failed: false, summary: "write: OK", result: { content: [] } };
      }
      return { failed: false, summary: "read: OK", result: { content: [] } };
    } });
  const done = async id => { let record; await waitFor(async () => { record = JSON.parse(await fs.readFile(path.join(dir, id + ".json"))); return record.finished_at; }); return record; };
  const writerId = idOf(await manager.run({ execution: "async", steps: [{ kind: "write" }] }));
  await waitFor(() => writerStarted);
  const args = prompt => ({ execution: "async", task_timeout_ms: 30000, steps: [{ kind: "codex", cwd,
    permissions: "full-access", request_id: randomUUID(), prompt }] });
  const blockedArgs = args("ok");
  const blockedId = idOf(await adapter.submit(blockedArgs, manager.run));
  assert(text((await done(blockedId)).steps[0].result).includes("CODEX_EXECUTION_LOCKED"));
  releaseWriter(); await done(writerId);
  checks.push("remote_writer_blocks_codex");

  const cancellationManager = createTaskManager({ dir, taskId, idPattern: /^task_[a-z0-9]+_[a-z0-9]{6}$/,
    textOf: text, compactText: String, truncate: (s, n) => s.slice(0, n), redactHistory: String,
    executeStep: async (step, context) => {
      await new Promise(resolve => {
        if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", resolve, { once: true });
      });
      return { failed: true, status: "cancelled", summary: "run: cancellation fixture", result: { content: [] } };
    } });
  const cancelledId = idOf(await cancellationManager.run({ execution: "async", steps: [{ kind: "run" }] }));
  await waitFor(async () => await exists(guard.active));
  await cancellationManager.inspect({ task_id: cancelledId, action: "cancel" });
  const cancelled = await done(cancelledId);
  assert.equal(cancelled.guard_state, "unknown"); assert(await exists(guard.active));
  await recoverExecution({ dir, approval: await approvalFor(cancelledId), confirm: async () => true });
  checks.push("guarded_remote_cancellation_retains_lock_until_review");

  const crashArgs = args("crash"), crashId = idOf(await adapter.submit(crashArgs, manager.run));
  const crashed = await done(crashId);
  assert.equal(crashed.status, "failed");
  approval = await approvalFor(crashId);
  const info = await inspectRecovery(dir);
  assert(info.active.record.owner.started_at && info.active.record.processes.length > 0);
  await assert.rejects(recoverExecution({ dir, approval: { ...approval, files_reviewed: false }, confirm: async () => true }), { code: "REMOTE_APPROVAL_INCOMPLETE" });
  await assert.rejects(recoverExecution({ dir, approval: { ...approval, lock_sha256: "0".repeat(64) }, confirm: async () => true }), { code: "REMOTE_LOCK_CHANGED" });
  await assert.rejects(recoverExecution({ dir, approval, confirm: async () => false }), { code: "REMOTE_HUMAN_APPROVAL_REQUIRED" });
  assert(await exists(guard.active));
  checks.push("pid_disappearance_never_auto_unlocks", "file_external_process_review_required", "stale_hash_rejected", "explicit_confirmation_required");

  const approvalFile = path.join(root, "fixture-approval.json");
  await fs.writeFile(approvalFile, JSON.stringify(approval));
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, [path.join(import.meta.dirname, "..", "scripts", "remote-maintenance.mjs"), "recover", "--task-dir", dir, "--approval", approvalFile]),
    error => error.stderr.includes("REMOTE_LOCAL_INTERACTIVE_CONSOLE_REQUIRED"));
  assert(await exists(guard.active));
  checks.push("maintenance_cli_rejects_unattended_unlock");
  await assert.rejects(run(process.execPath, [path.join(import.meta.dirname, "..", "scripts", "recover-guided.mjs"), "--task-dir", dir]),
    error => error.stderr.includes("REMOTE_LOCAL_INTERACTIVE_CONSOLE_REQUIRED"));
  assert(await exists(guard.active));
  checks.push("guided_recovery_rejects_noninteractive_invocation");

  const snapshot = (await lockSnapshot(guard.active)).record;
  await writeRecord(guard.active, { ...snapshot, namespace: randomUUID() });
  await assert.rejects(recoverExecution({ dir, approval: await approvalFor(crashId), confirm: async () => true }), { code: "REMOTE_STORE_NAMESPACE_MISMATCH" });
  await writeRecord(guard.active, snapshot);
  checks.push("wrong_store_namespace_cannot_be_recovered");
  await writeRecord(guard.active, { ...snapshot, processes: [...snapshot.processes, snapshot.owner] });
  await assert.rejects(recoverExecution({ dir, approval: await approvalFor(crashId), confirm: async () => true }), { code: "REMOTE_OWNED_PROCESS_STILL_ALIVE" });
  await writeRecord(guard.active, snapshot);
  approval = await approvalFor(crashId);
  checks.push("live_owned_process_cannot_be_unlocked");

  await assert.rejects(recoverExecution({ dir, approval, confirm: async () => {
    await writeRecord(guard.active, { ...snapshot, changed_by_fixture: true }); return true;
  } }), { code: "REMOTE_LOCK_CHANGED" });
  assert(await exists(guard.active));
  assert(!await exists(guard.maintenance));
  checks.push("lock_revalidated_after_human_confirmation");

  // Unknown evidence must survive normal output pruning.
  for (let i = 0; i < 103; i++) await writeRecord(path.join(dir, `task_a${i.toString(36)}_abcdef.json`),
    { id: `task_a${i.toString(36)}_abcdef`, status: "succeeded", finished_at: new Date().toISOString(), steps: [] });
  await manager.run({ steps: [{ kind: "read" }] });
  assert(await exists(path.join(dir, crashId + ".json")));
  checks.push("active_unknown_evidence_survives_pruning");

  approval = await approvalFor(crashId);
  const recovered = await recoverExecution({ dir, approval, confirm: async () => true });
  const audit = JSON.parse(await fs.readFile(path.join(dir, "codex", "recovery", recovered.audit_id + ".json")));
  assert.equal(audit.decision, "released"); assert.equal(audit.approval_sha256.length, 64);
  assert(!await exists(guard.active));
  const after = JSON.parse(await fs.readFile(path.join(dir, crashId + ".json")));
  assert.equal(after.status, "failed"); assert.equal(after.recovery.audit_id, recovered.audit_id);
  assert.equal(idOf(await adapter.submit(crashArgs, manager.run)), crashId);
  const convId = JSON.parse(text(crashed.steps[0].result)).conversation_id;
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "codex", convId + ".json"))).state, "interrupted");
  checks.push("approved_recovery_audited", "recovery_does_not_upgrade_outcome", "recovered_request_never_replayed", "interrupted_thread_never_reset_to_idle");
  await fs.unlink(path.join(dir, blockedId + ".json")).catch(() => {});
  assert.equal(idOf(await adapter.submit(blockedArgs, manager.run)), blockedId);
  checks.push("expired_task_output_never_replays_request");
  const final = await done(idOf(await adapter.submit(args("ok"), manager.run)));
  assert.equal(final.status, "succeeded");
  checks.push("new_deliberate_request_after_recovery_succeeds");
  evidence.passed = true;
} finally {
  if (held) await held.release();
  if (process.env.THRIFTYRELAY_TEST_EVIDENCE) await fs.writeFile(process.env.THRIFTYRELAY_TEST_EVIDENCE, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
