import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluateCodexQuota, evaluateCodexQuotaSnapshot } from "../src/codex/quota-gate.mjs";
import { createCodexAdapter } from "../src/codex/adapter.mjs";
import { createTaskManager } from "../src/mcp/task-manager.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "thrifty-quota-gate-"));
const priorEnv = Object.fromEntries(["CODEX_HOME", "THRIFTYRELAY_CODEX_WORKSPACE", "THRIFTYRELAY_TASK_DIR",
  "THRIFTYRELAY_CONFIG_PATH", "OPENAI_API_KEY", "CODEX_API_KEY"].map(name => [name, process.env[name]]));
const fixtures = [];
const textOf = result => result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
const taskId = () => `task_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 6)}`;
const idPattern = /^task_[a-z0-9]+_[a-z0-9]{6}$/;
const reset5h = "2026-10-18T05:00:00.000Z";
const reset1w = "2026-10-25T00:00:00.000Z";
const snapshot = (five = 80, weekly = 70) => ({ status: "ok", checked_at: "2026-10-18T00:00:00.000Z",
  five_hour: { remaining_percent: five, resets_at: reset5h },
  weekly: { remaining_percent: weekly, resets_at: reset1w } });
const quotaReaderFor = (...values) => {
  let index = 0;
  const reader = async () => structuredClone(values[Math.min(index++, values.length - 1)]);
  reader.calls = () => index;
  return reader;
};
const idOf = result => textOf(result).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0];
const requestFile = (dir, id) => path.join(dir, "codex", "requests", createHash("sha256").update(id).digest("hex") + ".json");
const waitForTask = async (dir, id) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const task = JSON.parse(await fs.readFile(path.join(dir, id + ".json"), "utf8"));
    if (task.finished_at) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("QUOTA_FIXTURE_TASK_TIMEOUT");
};

async function fixture(name, { quotaReader = quotaReaderFor(snapshot()), settings } = {}) {
  const base = path.join(root, name), cwd = path.join(base, "workspace"), dir = path.join(base, "tasks");
  const home = path.join(base, "auth"), configFile = path.join(base, "config.json");
  await Promise.all([fs.mkdir(cwd, { recursive: true }), fs.mkdir(dir, { recursive: true }), fs.mkdir(home, { recursive: true })]);
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-only-not-a-credential" } }));
  if (settings) await fs.writeFile(configFile, JSON.stringify(settings));
  process.env.CODEX_HOME = home;
  process.env.THRIFTYRELAY_CODEX_WORKSPACE = cwd;
  const adapter = createCodexAdapter({ dir, taskId, quotaReader, configFile,
    workerFile: new URL("./test-codex-worker.mjs", import.meta.url) });
  const manager = createTaskManager({ dir, taskId, idPattern, textOf: textOf,
    compactText: String, truncate: (value, max) => value.slice(0, max), redactHistory: String,
    executeStep: (step, context) => adapter.execute(step, context) });
  const args = (requestId = `r_${randomUUID()}`, extra = {}) => ({ execution: "async", task_timeout_ms: 30000,
    steps: [{ kind: "codex", cwd, request_id: requestId, permissions: "full-access", prompt: "ok",
      task_type: "code", expected_files: ["invocations.txt"], ...extra }] });
  const row = { base, cwd, dir, configFile, adapter, manager, quotaReader, args };
  fixtures.push(row);
  return row;
}

try {
  const defaultSettings = { fiveHourLimitPercent: 10, weeklyLimitPercent: 10,
    fiveHourLimitAction: "warn", weeklyLimitAction: "warn" };
  const evaluate = (five, weekly, overrides = {}) => evaluateCodexQuotaSnapshot(snapshot(five, weekly),
    { ...defaultSettings, ...overrides });
  assert.equal(evaluate(10.01, 10.01).code, "CODEX_QUOTA_ALLOWED", ">10% allows dispatch");
  assert.equal(evaluate(10, 90).code, "CODEX_QUOTA_APPROVAL_REQUIRED", "equality warns");
  assert.equal(evaluate(90, 9).code, "CODEX_QUOTA_APPROVAL_REQUIRED", "below threshold warns");
  assert.deepEqual(evaluate(10, 90).reached, ["five_hour"], "five-hour window evaluated independently");
  assert.deepEqual(evaluate(90, 10).reached, ["weekly"], "weekly window evaluated independently");
  assert.deepEqual(evaluate(10, 10).reached, ["five_hour", "weekly"], "both windows can warn together");
  assert.equal(evaluate(10, 90, { fiveHourLimitAction: "block" }).code, "CODEX_QUOTA_BLOCKED", "five-hour block");
  assert.equal(evaluate(90, 10, { weeklyLimitAction: "block" }).code, "CODEX_QUOTA_BLOCKED", "weekly block");
  assert.equal(evaluate(10, 90, { fiveHourLimitAction: "warn", weeklyLimitAction: "block", weeklyLimitPercent: 90 }).code,
    "CODEX_QUOTA_BLOCKED", "block takes priority when both windows reach thresholds");
  assert.equal(evaluateCodexQuotaSnapshot({ status: "unavailable" }, defaultSettings).code, "CODEX_QUOTA_UNAVAILABLE");
  assert.equal(evaluateCodexQuotaSnapshot({ ...snapshot(), weekly: null }, defaultSettings).code, "CODEX_QUOTA_UNAVAILABLE");
  assert.equal((await evaluateCodexQuota({ settings: defaultSettings, quotaReader: async () => { throw new Error("fixture"); } })).code,
    "CODEX_QUOTA_UNAVAILABLE", "reader errors fail closed");
  console.log("PASS: quota evaluator boundaries, each action, combined windows, and unavailable snapshots");

  const allowedReader = quotaReaderFor(snapshot(10.01, 30));
  const allowed = await fixture("allowed", { quotaReader: allowedReader });
  let allowedRuns = 0;
  const allowedResponse = await allowed.adapter.submit(allowed.args(), async (_args, admission) => {
    allowedRuns++;
    return { content: [{ type: "text", text: `Task ${admission.id}: started` }] };
  });
  assert.equal(allowedRuns, 1);
  assert.equal(allowedReader.calls(), 1);
  assert(idOf(allowedResponse));
  console.log("PASS: above-threshold new request reads both quotas before one dispatch");

  const warningReader = quotaReaderFor(snapshot(10, 65));
  const warning = await fixture("warning", { quotaReader: warningReader });
  const warningArgs = warning.args("r_warning_00000001");
  let warningRuns = 0;
  const warningResult = await warning.adapter.submit(warningArgs, async () => { warningRuns++; throw new Error("must not dispatch"); });
  const warningData = warningResult.structuredContent;
  assert.equal(warningData.code, "CODEX_QUOTA_APPROVAL_REQUIRED");
  assert.equal(warningData.windows.length, 2);
  assert.deepEqual(warningData.windows.map(row => [row.name, row.remaining_percent, row.threshold_percent, row.resets_at]), [
    ["five_hour", 10, 10, reset5h], ["weekly", 65, 10, reset1w],
  ]);
  assert.match(warningData.quota_approval_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(textOf(warningResult), /CODEX_QUOTA_APPROVAL_REQUIRED_JSON=/);
  assert.equal(idOf(warningResult), undefined);
  assert.equal(warningRuns, 0);
  const pending = JSON.parse(await fs.readFile(requestFile(warning.dir, "r_warning_00000001"), "utf8"));
  assert.equal(pending.state, "quota_warning_pending");
  assert.equal(Object.hasOwn(pending, "task_id"), false);
  assert.equal(pending.quota_warning_approved, false);
  assert.equal(warningReader.calls(), 1);
  await warning.adapter.submit(warningArgs, async () => { warningRuns++; throw new Error("must not dispatch"); });
  assert.equal(warningReader.calls(), 1, "a pending warning retry does not reread or dispatch");
  assert.equal(warningRuns, 0);
  console.log("PASS: equality warning persists a challenge only and exposes human plus machine-readable 5h/1w values");

  const blocked = await fixture("blocked", { quotaReader: quotaReaderFor(snapshot(9, 80)),
    settings: { fiveHourLimitPercent: 10, weeklyLimitPercent: 10, fiveHourLimitAction: "block", weeklyLimitAction: "warn" } });
  let blockedRuns = 0;
  const blockedResult = await blocked.adapter.submit(blocked.args("r_blocked_00000001"), async () => { blockedRuns++; });
  assert.equal(blockedResult.structuredContent.code, "CODEX_QUOTA_BLOCKED");
  assert.equal(blockedRuns, 0);
  await assert.rejects(fs.access(requestFile(blocked.dir, "r_blocked_00000001")));
  assert.equal((await fs.readdir(path.join(blocked.dir, "codex", "requests"))).some(name => name.endsWith(".approval.lock")), false);

  const missing = await fixture("missing", { quotaReader: quotaReaderFor({ ...snapshot(), weekly: null }) });
  let missingRuns = 0;
  const missingResult = await missing.adapter.submit(missing.args("r_missing_00000001"), async () => { missingRuns++; });
  assert.equal(missingResult.structuredContent.code, "CODEX_QUOTA_UNAVAILABLE");
  assert.equal(missingRuns, 0);
  assert.equal((await fs.readdir(missing.dir)).some(name => name.endsWith(".json")), false);
  console.log("PASS: block and missing-window responses create no task or lingering approval lock");

  const spoof = await fixture("spoof", { quotaReader: quotaReaderFor(snapshot(10, 90)) });
  let spoofRuns = 0;
  const bareSpoof = await spoof.adapter.submit(spoof.args("r_spoofed_00000001", { quota_warning_approved: true }), async () => { spoofRuns++; });
  assert.match(textOf(bareSpoof), /CODEX_QUOTA_APPROVAL_INVALID/);
  const spoofResult = await spoof.adapter.submit(spoof.args("r_spoofed_00000001", {
    quota_warning_approved: true, quota_approval_token: "A".repeat(43),
  }), async () => { spoofRuns++; });
  assert.match(textOf(spoofResult), /CODEX_QUOTA_APPROVAL_INVALID/);
  assert.equal(spoof.quotaReader.calls(), 0, "bare approval cannot create a challenge or reach quota dispatch");
  assert.equal(spoofRuns, 0);
  console.log("PASS: spoofed approval without a durable challenge is rejected");

  const approvedReader = quotaReaderFor(snapshot(10, 60), snapshot(75, 80));
  const approved = await fixture("approved", { quotaReader: approvedReader });
  const approvedArgs = approved.args("r_approved_00000001");
  const issued = await approved.adapter.submit(approvedArgs, approved.manager.run);
  const token = issued.structuredContent.quota_approval_token;
  let approvedArgsWithToken = structuredClone(approvedArgs);
  approvedArgsWithToken.steps[0].quota_warning_approved = true;
  approvedArgsWithToken.steps[0].quota_approval_token = token;
  const accepted = await approved.adapter.submit(approvedArgsWithToken, approved.manager.run);
  const approvedId = idOf(accepted);
  assert(approvedId, textOf(accepted));
  const approvedTask = await waitForTask(approved.dir, approvedId);
  assert.equal(approvedTask.status, "succeeded");
  assert.equal(approvedTask.quota_warning_approved, true);
  const finalOutput = JSON.parse(textOf(approvedTask.steps[0].result));
  assert.equal(finalOutput.quota_warning_approved, true);
  assert.match(finalOutput.quota_approval_attestation, /cannot cryptographically verify/);
  assert.equal(finalOutput.review.quota_warning_approved, true);
  const reviewFile = JSON.parse(await fs.readFile(finalOutput.review.path, "utf8"));
  assert.equal(reviewFile.quota_warning_approved, true);
  assert.equal(reviewFile.quota_approval_attestation, finalOutput.quota_approval_attestation);
  const reserved = JSON.parse(await fs.readFile(requestFile(approved.dir, "r_approved_00000001"), "utf8"));
  assert.equal(reserved.state, "completed");
  assert.equal(reserved.quota_warning_approved, true);
  assert.equal(Object.hasOwn(reserved, "challenge"), false);
  assert.equal(JSON.stringify([approvedTask, finalOutput, reviewFile, reserved]).includes(token), false,
    "challenge token must not enter task records or generic reviews");
  assert.equal(approvedReader.calls(), 2, "approval re-fetches quotas immediately before dispatch");
  const duplicate = await approved.adapter.submit(approvedArgs, approved.manager.run);
  assert.equal(idOf(duplicate), approvedId);
  assert.equal(approvedReader.calls(), 2, "completed duplicate does not re-read quota");
  assert.equal(await fs.readFile(path.join(approved.cwd, "invocations.txt"), "utf8"), "run\n");
  const changed = structuredClone(approvedArgsWithToken);
  changed.steps[0].prompt = "different original intent";
  assert.match(textOf(await approved.adapter.submit(changed, approved.manager.run)), /CODEX_REQUEST_ID_CONFLICT/);
  console.log("PASS: valid challenge rechecks quota, dispatches once, and persists approval without storing token");

  const changedPending = await fixture("changed-pending", { quotaReader: quotaReaderFor(snapshot(10, 70)) });
  const changedInitial = changedPending.args("r_changed_00000001");
  const changedWarning = await changedPending.adapter.submit(changedInitial, async () => { throw new Error("must not run"); });
  const changedRetry = structuredClone(changedInitial);
  changedRetry.steps[0].prompt = "changed while approval pending";
  changedRetry.steps[0].quota_warning_approved = true;
  changedRetry.steps[0].quota_approval_token = changedWarning.structuredContent.quota_approval_token;
  assert.match(textOf(await changedPending.adapter.submit(changedRetry, async () => { throw new Error("must not run"); })),
    /CODEX_REQUEST_ID_CONFLICT/);
  assert.equal(changedPending.quotaReader.calls(), 1);

  const blockAfterWarning = await fixture("block-after-warning", { quotaReader: quotaReaderFor(snapshot(10, 90), snapshot(10, 90)) });
  const blockArgs = blockAfterWarning.args("r_block_after_warning_01");
  const blockWarning = await blockAfterWarning.adapter.submit(blockArgs, async () => { throw new Error("must not run"); });
  await fs.writeFile(blockAfterWarning.configFile, JSON.stringify({ fiveHourLimitPercent: 10, weeklyLimitPercent: 10,
    fiveHourLimitAction: "block", weeklyLimitAction: "warn" }));
  const blockedApproval = structuredClone(blockArgs);
  blockedApproval.steps[0].quota_warning_approved = true;
  blockedApproval.steps[0].quota_approval_token = blockWarning.structuredContent.quota_approval_token;
  const blockOnApproval = await blockAfterWarning.adapter.submit(blockedApproval, async () => { throw new Error("must not run"); });
  assert.equal(blockOnApproval.structuredContent.code, "CODEX_QUOTA_BLOCKED", "a valid token cannot bypass a newly active block");
  assert.equal(JSON.parse(await fs.readFile(requestFile(blockAfterWarning.dir, "r_block_after_warning_01"), "utf8")).state,
    "quota_warning_pending");
  assert.equal((await fs.readdir(path.join(blockAfterWarning.dir, "codex", "requests"))).some(name => name.endsWith(".approval.lock")), false);

  const unavailableAfterWarning = await fixture("unavailable-after-warning", { quotaReader: quotaReaderFor(snapshot(10, 90), { status: "unavailable" }) });
  const unavailableArgs = unavailableAfterWarning.args("r_unavailable_after_01");
  const unavailableWarning = await unavailableAfterWarning.adapter.submit(unavailableArgs, async () => { throw new Error("must not run"); });
  const unavailableApproval = structuredClone(unavailableArgs);
  unavailableApproval.steps[0].quota_warning_approved = true;
  unavailableApproval.steps[0].quota_approval_token = unavailableWarning.structuredContent.quota_approval_token;
  const deniedUnavailable = await unavailableAfterWarning.adapter.submit(unavailableApproval, async () => { throw new Error("must not run"); });
  assert.equal(deniedUnavailable.structuredContent.code, "CODEX_QUOTA_UNAVAILABLE");
  assert.equal((await fs.readdir(path.join(unavailableAfterWarning.dir, "codex", "requests"))).some(name => name.endsWith(".approval.lock")), false);
  console.log("PASS: changed intent, block override, and unavailable approval recheck fail closed");

  const racingReader = quotaReaderFor(snapshot(10, 80), snapshot(80, 80));
  const racing = await fixture("racing", { quotaReader: racingReader });
  const racingArgs = racing.args("r_concurrent_approval_01");
  const racingWarning = await racing.adapter.submit(racingArgs, racing.manager.run);
  const racingApproved = structuredClone(racingArgs);
  racingApproved.steps[0].quota_warning_approved = true;
  racingApproved.steps[0].quota_approval_token = racingWarning.structuredContent.quota_approval_token;
  const competitor = createCodexAdapter({ dir: racing.dir, taskId, quotaReader: racingReader, configFile: racing.configFile,
    workerFile: new URL("./test-codex-worker.mjs", import.meta.url) });
  const pair = await Promise.all([
    racing.adapter.submit(racingApproved, racing.manager.run),
    competitor.submit(racingApproved, racing.manager.run),
  ]);
  const [firstId, secondId] = pair.map(idOf);
  assert(firstId && secondId);
  assert.equal(firstId, secondId, "racing approved retries receive the original task ID");
  await waitForTask(racing.dir, firstId);
  assert.equal(await fs.readFile(path.join(racing.cwd, "invocations.txt"), "utf8"), "run\n");
  assert.equal(racingReader.calls(), 2, "only the winning approved transition rechecks quotas");
  console.log("PASS: concurrent approval retries serialize and dispatch the fixture worker once");

  const corrupt = await fixture("corrupt", { quotaReader: quotaReaderFor(snapshot()) });
  const corruptArgs = corrupt.args("r_corrupt_record_01");
  const corruptPath = requestFile(corrupt.dir, "r_corrupt_record_01");
  await fs.mkdir(path.dirname(corruptPath), { recursive: true });
  await fs.writeFile(corruptPath, "{");
  const corruptResult = await corrupt.adapter.submit(corruptArgs, async () => { throw new Error("must not run"); });
  assert.match(textOf(corruptResult), /CODEX_REQUEST_RECORD_INVALID/);
  assert.equal(corrupt.quotaReader.calls(), 0, "corrupt request records fail closed before quota admission");
  const linked = await fixture("symlink-record", { quotaReader: quotaReaderFor(snapshot()) });
  const linkId = "r_symlink_record_01";
  const linkPath = requestFile(linked.dir, linkId);
  const targetPath = path.join(linked.base, "outside-record.json");
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify({ request_id: linkId }));
  let symlinkAvailable = true;
  try { await fs.symlink(targetPath, linkPath, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) symlinkAvailable = false;
    else throw error;
  }
  if (symlinkAvailable) {
    const linkedResult = await linked.adapter.submit(linked.args(linkId), async () => { throw new Error("must not run"); });
    assert.match(textOf(linkedResult), /CODEX_REQUEST_RECORD_INVALID/);
    assert.equal(linked.quotaReader.calls(), 0);
    assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true, "symlink record must not be overwritten");
    console.log("PASS: corrupt and symlink request records fail closed without overwrite");
  } else console.log("PASS: corrupt request record rejected; symlink creation unavailable on this Windows profile");

  const appData = path.join(root, "mcp-appdata"), mcpTasks = path.join(root, "mcp-tasks");
  const appConfig = path.join(root, "mcp-config.json");
  const env = { ...process.env, THRIFTYRELAY_TASK_DIR: mcpTasks, THRIFTYRELAY_CONFIG_PATH: appConfig,
    APPDATA: appData, CODEX_HOME: path.join(root, "no-auth"), THRIFTYRELAY_CODEX_WORKSPACE: "",
    THRIFTYRELAY_TEST_POLICY_FILE: path.join(root, "missing-policy.json") };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href, path.join(appRoot, "index.mjs")],
    cwd: appRoot, env, stderr: "pipe" });
  transport.stderr?.resume();
  const client = new Client({ name: "quota-schema-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const remote = tools.find(tool => tool.name === "remote_task");
    const stepSchema = JSON.stringify(remote.inputSchema.properties.steps);
    assert(stepSchema.includes("quota_warning_approved"));
    assert(stepSchema.includes("quota_approval_token"));
    const toolInstructions = client.getInstructions() || "";
    assert(toolInstructions.includes("CODEX_QUOTA_APPROVAL_REQUIRED"));
    assert(toolInstructions.includes("never approve automatically"));
    assert(toolInstructions.includes("do not retry automatically"));
    const open = tools.find(tool => tool.name === "open_settings");
    const update = tools.find(tool => tool.name === "settings_update");
    assert.equal(Object.keys(update.inputSchema.properties).length, 9);
    for (const field of ["fiveHourLimitPercent", "weeklyLimitPercent", "fiveHourLimitAction", "weeklyLimitAction"]) {
      assert(Object.hasOwn(update.inputSchema.properties, field));
    }
    assert.match(open.description, /nine/);
    assert.match(update.description, /nine/);
    const allNine = await client.callTool({ name: "settings_update", arguments: {
      language: "en", baseModel: "gpt-6-luna/medium", upperModel: "disabled", maxCodexAgents: 1,
      reviewPolicy: "manual", fiveHourLimitPercent: 0, weeklyLimitPercent: 100,
      fiveHourLimitAction: "block", weeklyLimitAction: "warn",
    } });
    assert.equal(allNine.isError, undefined, textOf(allNine));
    assert.equal(Object.keys(allNine.structuredContent.settings).length, 9);
    const endpoints = await client.callTool({ name: "settings_update", arguments: { fiveHourLimitPercent: 100, weeklyLimitPercent: 0 } });
    assert.equal(endpoints.isError, undefined, textOf(endpoints));
    for (const invalid of [{ fiveHourLimitPercent: -1 }, { weeklyLimitPercent: 101 },
      { fiveHourLimitAction: "allow" }, { weeklyLimitAction: "deny" }]) {
      const rejected = await client.callTool({ name: "settings_update", arguments: invalid });
      assert.equal(rejected.isError, true, JSON.stringify(invalid));
    }
    const settings = await client.callTool({ name: "open_settings", arguments: {} });
    assert.equal(Object.keys(settings.structuredContent.settings).length, 9);
    assert.equal(settings.structuredContent.settings.fiveHourLimitPercent, 100);
    assert.equal(settings.structuredContent.settings.weeklyLimitPercent, 0);
    const resource = await client.readResource({ uri: "ui://thriftyrelay/settings-v2.html" });
    const html = resource.contents.find(item => item.uri === "ui://thriftyrelay/settings-v2.html")?.text || "";
    assert(html.startsWith("<!doctype html>"));
    for (const field of ["fiveHourLimitPercent", "weeklyLimitPercent", "fiveHourLimitAction", "weeklyLimitAction"]) {
      assert(html.includes(field), `rebuilt settings resource is missing ${field}`);
    }
    console.log("PASS: MCP quota approval schema/instructions and isolated nine-setting 0..100 validation");
  } finally { await client.close(); }

  console.log("PASS: quota gate and MCP integration tests (fixture worker only; no real Codex inference)");
} finally {
  for (const fixture of fixtures) {
    // The workers in this suite are short fixtures; cancel any task left active by an assertion failure.
    try {
      for (const file of await fs.readdir(fixture.dir)) {
        if (!idPattern.test(file.replace(/\.json$/, "")) || !file.endsWith(".json")) continue;
        const task = JSON.parse(await fs.readFile(path.join(fixture.dir, file), "utf8"));
        if (!task.finished_at && task.codex_request_id) await fixture.manager.inspect({ task_id: task.id, action: "cancel", wait_ms: 0 });
      }
    } catch {}
  }
  try { await fs.rm(root, { recursive: true, force: true }); } catch {}
  for (const [name, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
