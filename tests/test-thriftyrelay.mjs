import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCodexAdapter } from "../src/codex/adapter.mjs";
import { createTaskManager } from "../src/mcp/task-manager.mjs";
import { snapshotFiles, compareFiles } from "../src/codex/review-evidence.mjs";
import { testArea } from "./test-artifacts.mjs";
import { fixtureQuotaReader } from "./quota-fixture.mjs";

const root = path.join(process.env.THRIFTYRELAY_TEST_ROOT, "relay"); await fs.mkdir(root);
const home = path.join(root, "auth"); await fs.mkdir(home);
await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-only" } }));
process.env.CODEX_HOME = home;
const checks = [], evidence = { checks, live: false };
const text = result => result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
const taskId = () => `task_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
const idOf = result => { assert(!result.isError, text(result)); return text(result).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0]; };
async function fixture(name) {
  const base = path.join(root, name), cwd = path.join(base, "workspace"), dir = path.join(base, "tasks");
  await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(dir);
  process.env.THRIFTYRELAY_CODEX_WORKSPACE = cwd;
  const adapter = createCodexAdapter({ dir, taskId, workerFile: new URL("./test-relay-worker.mjs", import.meta.url),
    quotaReader: fixtureQuotaReader, configFile: path.join(dir, "fixture-config.json") });
  const manager = createTaskManager({ dir, taskId, idPattern: /^task_[a-z0-9]+_[a-z0-9]{6}$/,
    textOf: text, compactText: String, truncate: (s,n) => s.slice(0,n), redactHistory: String,
    executeStep: (step, context) => adapter.execute(step, context) });
  const args = (extra = {}) => ({ execution: "async", task_timeout_ms: 30000,
    steps: [{ kind: "codex", cwd, permissions: "full-access", request_id: randomUUID(), prompt: "ok", ...extra }] });
  const run = async value => {
    const id = idOf(await adapter.submit(value, manager.run)); const end = Date.now() + 25000;
    while (Date.now() < end) {
      const task = JSON.parse(await fs.readFile(path.join(dir, id + ".json")));
      if (task.finished_at) return { id, task, output: JSON.parse(text(task.steps[0].result)) };
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error("fixture timeout");
  };
  return { cwd, dir, base, adapter, manager, args, run };
}
try {
  const f = await fixture("selection");
  const legacy = await f.run(f.args());
  assert.equal(legacy.output.model, "gpt-6-luna"); assert.equal(legacy.output.reasoning_effort, "max");

  // ChatGPT names a role; the saved settings at submission time decide the model and effort.
  const roles = await fixture("roles");
  const rolesConfig = path.join(roles.dir, "fixture-config.json");
  const upper = await roles.run(roles.args({ model_role: "upper" }));
  assert.equal(upper.output.model, "gpt-6.1-sol"); assert.equal(upper.output.reasoning_effort, "medium");
  await fs.writeFile(rolesConfig, JSON.stringify({ baseModel: "gpt-6-luna/high", upperModel: "disabled" }));
  const changedBase = await roles.run(roles.args({ model_role: "base" }));
  assert.equal(changedBase.output.model, "gpt-6-luna"); assert.equal(changedBase.output.reasoning_effort, "high");
  const disabled = await roles.adapter.submit(roles.args({ model_role: "upper" }), () => { throw new Error("must never dispatch"); });
  assert.match(text(disabled), /CODEX_UPPER_MODEL_DISABLED/);
  checks.push("upper_role_uses_upper_setting", "base_role_follows_saved_settings", "disabled_upper_role_refused");
  process.env.THRIFTYRELAY_CODEX_WORKSPACE = f.cwd;
  const lunaArgs = f.args({ model: "gpt-6-luna" }); const luna = await f.run(lunaArgs);
  assert.equal(luna.output.model, "gpt-6-luna"); assert.equal(luna.output.reasoning_effort, "max");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.base, "selection.json"))), { model: "gpt-6-luna", reasoning_effort: "max" });
  const inheritedArgs = f.args({ conversation_id: luna.output.conversation_id });
  const inherited = await f.run(inheritedArgs); assert.equal(inherited.output.model, "gpt-6-luna");
  const switched = await f.run(f.args({ conversation_id: luna.output.conversation_id, model: "gpt-6.1-sol" }));
  assert.equal(switched.output.reasoning_effort, "medium"); assert.equal(switched.output.conversation_id, luna.output.conversation_id);
  const invalidEffort=await f.adapter.submit(f.args({conversation_id:luna.output.conversation_id,reasoning_effort:"low"}), f.manager.run);
  assert.match(text(invalidEffort), /CODEX_REASONING_UNSUPPORTED/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,"codex",luna.output.conversation_id+".json"))).state,"idle");
  assert.equal(idOf(await f.adapter.submit(inheritedArgs, f.manager.run)), inherited.id);
  const conflict = structuredClone(lunaArgs); conflict.steps[0].model = "gpt-6.1-sol";
  assert(text(await f.adapter.submit(conflict, f.manager.run)).includes("CODEX_REQUEST_ID_CONFLICT"));
  checks.push("new_request_uses_base_model", "luna_payload_max", "continuation_inherits_luna", "explicit_switch_same_conversation", "invalid_effort_preserves_idle_conversation", "retry_stable_after_selection_changes", "model_change_same_id_rejected");
  // A request record in a format this version does not write is refused, never treated as new.
  const oldArgs = f.args(), s = oldArgs.steps[0];
  await fs.writeFile(path.join(f.dir, "codex", "requests", createHash("sha256").update(s.request_id).digest("hex") + ".json"),
    JSON.stringify({ version: 2, request_id: s.request_id, fingerprint: "0".repeat(64), task_id: "task_oldtest_abcdef", state: "execution_unknown" }));
  assert.match(text(await f.adapter.submit(oldArgs, () => { throw new Error("must never dispatch"); })), /CODEX_REQUEST_RECORD_INVALID/);
  const oldConversationFile = path.join(f.dir, "codex", legacy.output.conversation_id + ".json");
  const oldConversation = JSON.parse(await fs.readFile(oldConversationFile)); delete oldConversation.model; delete oldConversation.reasoning_effort;
  await fs.writeFile(oldConversationFile, JSON.stringify(oldConversation));
  assert.equal((await f.run(f.args({ conversation_id: oldConversation.id }))).output.model, "gpt-6.1-sol");
  checks.push("old_request_record_refused_without_dispatch", "conversation_without_model_continues");

  const r = await fixture("review");
  await fs.writeFile(path.join(r.cwd, "sum.mjs"), "export const sum = (a,b) => a-b;\n");
  await fs.writeFile(path.join(r.cwd, "dirty.txt"), "preexisting user state\n");
  const edit = await r.run(r.args({ model: "gpt-6-luna", task_type: "code", expected_files: ["sum.mjs"], prompt: "edit" }));
  assert.equal(edit.task.status, "succeeded"); assert.equal(edit.output.review.summary.complete, true);
  const review = JSON.parse(await fs.readFile(edit.output.review.path));
  assert.deepEqual(review.files.unexpected, ["surprise.txt"]);
  assert(!review.files.changes.some(item => item.path === "dirty.txt"));
  assert.equal(review.commands[0].exit_code, 0); assert.equal(review.commands[0].output, "ASSERT_OK");
  const handoff = "handoff: actual unexpected files " + review.files.unexpected.join(",") + "; original task " + edit.id + "; remove unintended file, preserve sum and dirty state";
  const repair = await r.run(r.args({ model: "gpt-6.1-sol", task_type: "code", expected_files: ["surprise.txt"], prompt: handoff, conversation_id: edit.output.conversation_id }));
  assert.equal(repair.output.review.summary.unexpected_count, 0);
  assert.equal(repair.output.review.summary.changed_count, 1);
  assert.equal(await fs.readFile(path.join(r.cwd, "dirty.txt"), "utf8"), "preexisting user state\n");
  checks.push("non_git_actual_change_review", "unexpected_change_detected", "preexisting_dirty_preserved", "real_fixture_command_exit_and_output", "evidence_handoff_to_sol");
  execFileSync("git", ["init", "--quiet"], { cwd: r.cwd, windowsHide: true });
  execFileSync("git", ["add", "sum.mjs"], { cwd: r.cwd, windowsHide: true });
  const before = await snapshotFiles(r.cwd);
  await fs.writeFile(path.join(r.cwd, "sum.mjs"), "export const sum = (a,b) => a+b+1;\n");
  const after = await snapshotFiles(r.cwd), gitReview = compareFiles(before, after, ["sum.mjs"]);
  assert.deepEqual(gitReview.changes.map(item => item.path), ["sum.mjs"]);
  assert(execFileSync("git", ["diff", "--name-only"], { cwd: r.cwd, windowsHide: true, encoding: "utf8" }).includes("sum.mjs"));
  const large = path.join(r.cwd, "large.bin"); await fs.writeFile(large, Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal((await snapshotFiles(r.cwd)).complete, false); await fs.unlink(large);
  assert(text(await r.adapter.submit(r.args({ expected_files: ["../escape"] }), r.manager.run)).includes("CODEX_EXPECTED_FILES_INVALID"));
  await fs.writeFile(path.join(r.cwd,"__proto__"),"ordinary file name");
  assert(Object.hasOwn((await snapshotFiles(r.cwd)).files,"__proto__"));
  checks.push("git_existing_diff_reused", "oversized_scope_incomplete", "expected_path_traversal_rejected");
  checks.push("special_object_key_filename_recorded");

  const u = await fixture("unavailable"); const failed = await u.run(u.args({ model: "gpt-6-luna", prompt: "unavailable" }));
  assert.equal(failed.output.error, "CODEX_MODEL_UNAVAILABLE"); assert(failed.output.lock_retained);
  checks.push("unavailable_explicit_error_no_model_fallback");

  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href, path.join(import.meta.dirname, "..", "index.mjs")],
    cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, THRIFTYRELAY_TASK_DIR: path.join(root,"protocol"),
      THRIFTYRELAY_TEST_POLICY_FILE: path.join(root, "missing-policy.json"),
      THRIFTYRELAY_CODEX_WORKSPACE: r.cwd }, stderr: "pipe" });
  transport.stderr?.resume(); const client = new Client({name:"relay-schema",version:"1"},{capabilities:{}});
  try {
    await client.connect(transport); const tools = (await client.listTools()).tools;
    evidence.health=text(await client.callTool({name:"health",arguments:{}}));
    assert.deepEqual(tools.map(item=>item.name),["health","remote_task","open_approval","pending_approvals","approve_task","decline_task","approval_step","remote_inspect","open_settings","settings_update"]);
    const remoteTask=JSON.stringify(tools.find(item=>item.name==="remote_task"));
    assert(remoteTask.includes('"model_role"') && remoteTask.includes('"base"') && remoteTask.includes('"upper"'));
    assert(!/gpt-6/.test(remoteTask) && !/gpt-6/.test(client.getInstructions()), "ChatGPT sees roles, not model names");
    assert(client.getInstructions().includes(path.join("docs", "en", "orchestration.md")));
    const denied=await client.callTool({name:"remote_task",arguments:r.args({model_role:"base",readOnly:true})});
    assert(denied.isError && text(denied).includes("CODEX_READONLY_UNAVAILABLE"));
  } finally { await client.close(); }
  checks.push("public_schema_offers_model_roles_only", "readonly_still_rejected");

  const area=await testArea(path.join(root,"managed"));
  const clean=await area.begin("clean"); await fs.writeFile(path.join(clean.root,"temporary.txt"),"owned");
  assert((await clean.finish({success:true,processes_stopped:true,evidence:"cleanup fixture"})).cleanup.removed);
  const unknown=await area.begin("unknown"); await fs.writeFile(path.join(unknown.root,"task_unknown_abcdef.json"),JSON.stringify({status:"running"}));
  assert(!(await unknown.finish({success:true,processes_stopped:true})).cleanup.removed);
  const durable=await area.begin("durable"); await fs.mkdir(path.join(durable.root,"codex","requests"),{recursive:true});
  await fs.writeFile(path.join(durable.root,"codex","requests","keep.json"),"{}");
  assert(!(await durable.finish({success:true,processes_stopped:true})).cleanup.removed);
  const failedRun=await area.begin("failed"); assert(!(await failedRun.finish({success:false,processes_stopped:true})).cleanup.removed);
  const unowned=path.join(root,"unowned"); await fs.mkdir(unowned); await fs.writeFile(path.join(unowned,"user.txt"),"keep");
  await assert.rejects(testArea(unowned),{code:"TEST_ROOT_NOT_OWNED"});
  const priorBudget=process.env.THRIFTY_TEST_MAX_BYTES; process.env.THRIFTY_TEST_MAX_BYTES="1";
  await assert.rejects((await testArea(area.root)).begin("overbudget"),{code:"TEST_CAPACITY_EXCEEDED_PROTECTED_EVIDENCE_RETAINED"});
  if(priorBudget===undefined) delete process.env.THRIFTY_TEST_MAX_BYTES; else process.env.THRIFTY_TEST_MAX_BYTES=priorBudget;
  assert.equal(await fs.readFile(path.join(unowned,"user.txt"),"utf8"),"keep");
  const stale=await area.begin("stale"), staleFile=path.join(stale.runDir,"run.json");
  const staleRecord=JSON.parse(await fs.readFile(staleFile)); Object.assign(staleRecord,{state:"passed",processes_stopped:true,finished_at:"2000-01-01T00:00:00Z"});
  await fs.writeFile(staleFile,JSON.stringify(staleRecord));
  assert((await area.sweep()).some(item=>item.run===staleRecord.id && item.removed));
  assert(await fs.stat(path.join(durable.root,"codex","requests","keep.json")));
  checks.push("owned_success_payload_cleaned", "unknown_task_preserved", "tombstone_preserved", "failed_run_preserved", "unowned_files_rejected", "quota_refuses_without_deletion", "age_sweep_only_safe_success");
  evidence.passed=true;
} finally {
  await fs.writeFile(process.env.THRIFTYRELAY_TEST_EVIDENCE, JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence));
}
