import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanupScratch, createTaskScratch, MAX_SCRATCH_ENTRIES, resolveScratchStep,
  SCRATCH_RETENTION_MS, scratchOutcome, taskScratchPath,
} from "../src/mcp/scratch.mjs";
import { createTaskManager } from "../src/mcp/task-manager.mjs";

// Scratch is the one area cleanup may delete without asking. These assertions pin the two
// mistakes that would make that dangerous: deleting evidence for an unresolved task, and
// deleting a directory that is not the one the owner record names.
const checks = [];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-"));
const tasks = path.join(root, "tasks");
await fs.mkdir(tasks);
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const ID = /^task_[a-z0-9]+_[a-z0-9]{6}$/;

assert.equal(taskScratchPath("/tmp/scratch", "task_a_abc123", { platform: "linux" }),
  "/tmp/scratch/task_a_abc123");
assert.throws(() => taskScratchPath("/tmp/scratch", "../escape", { platform: "linux" }),
  { code: "SCRATCH_TASK_ID_INVALID" });
const created = await createTaskScratch({
  root, taskId: "task_a_abc123", platform: process.platform, now: NOW,
});
assert.equal(created, path.join(root, "task_a_abc123"));
assert.deepEqual(JSON.parse(await fs.readFile(path.join(created, "owner.json"), "utf8")), {
  version: 1, task_id: "task_a_abc123", created_at: new Date(NOW).toISOString(),
});
checks.push("create-and-owner-record");

// The same task may reuse its directory; another task may not take it over.
await createTaskScratch({ root, taskId: "task_a_abc123", platform: process.platform, now: NOW });
await assert.rejects(createTaskScratch({ root, taskId: "task_a_abc123", platform: process.platform, now: NOW })
  .then(async () => {
    await fs.writeFile(path.join(created, "owner.json"), JSON.stringify({ task_id: "task_b_def456" }));
    return createTaskScratch({ root, taskId: "task_a_abc123", platform: process.platform, now: NOW });
  }), { code: "SCRATCH_OWNER_CONFLICT" });
checks.push("owner-conflict");

// Relative paths and the token both resolve inside this task's directory. Absolute paths are
// left for the ordinary admission rules.
const dir = path.join(root, "task_c_ghi789");
assert.equal(resolveScratchStep({ kind: "write", path: "out/a.txt" }, dir).path,
  path.join(dir, "out", "a.txt"));
assert.equal(resolveScratchStep({ kind: "read", path: "{{scratch}}/a.txt" }, dir).path,
  path.join(dir, "a.txt"));
assert.equal(resolveScratchStep({ kind: "edit", file_path: "./a.txt" }, dir).file_path, path.join(dir, "a.txt"));
assert.equal(resolveScratchStep({ kind: "patch", files: [{ path: "a.js" }] }, dir).files[0].path,
  path.join(dir, "a.js"));
assert.equal(resolveScratchStep({ kind: "codex", cwd: "." }, dir).cwd, dir);
assert.equal(resolveScratchStep({ kind: "run", command: "cd \"{{scratch}}\" && ls" }, dir).command,
  `cd "${dir}" && ls`);
const absolute = path.join(root, "outside.txt");
assert.equal(resolveScratchStep({ kind: "read", path: absolute }, dir).path, absolute);
assert.throws(() => resolveScratchStep({ kind: "write", path: "../escape.txt" }, dir),
  { code: "SCRATCH_PATH_ESCAPE" });
assert.throws(() => resolveScratchStep({ kind: "read", path: "{{scratch}}/../escape.txt" }, dir),
  { code: "SCRATCH_PATH_ESCAPE" });
checks.push("relative-and-token-paths");

// Outcomes decide deletion. A success is disposable; a failure is retained; an unresolved or
// recovered task is evidence and is never removed by the ordinary sweep.
assert.equal(scratchOutcome({ status: "succeeded", finished_at: "x" }), "remove");
assert.equal(scratchOutcome({ status: "failed", finished_at: "x" }), "keep");
assert.equal(scratchOutcome({ status: "succeeded", finished_at: "x", guard_state: "unknown" }), "protect");
assert.equal(scratchOutcome({ status: "failed", finished_at: "x", execution_unknown: true }), "protect");
assert.equal(scratchOutcome({ status: "failed", finished_at: "x", execution_unknown: true, recovery: true }), "protect");
assert.equal(scratchOutcome({ status: "failed", finished_at: "x", guard_state: "recovered", recovery: { audit_id: "a" } }), "protect");
assert.equal(scratchOutcome({ status: "running" }), "protect");
assert.equal(scratchOutcome({ status: "succeeded" }), "protect");
checks.push("outcome-policy");

async function record(id, value) {
  await fs.writeFile(path.join(tasks, id + ".json"), JSON.stringify({ id, ...value }));
}

await createTaskScratch({ root, taskId: "task_done_abc001", platform: process.platform, now: NOW });
await createTaskScratch({ root, taskId: "task_fail_abc002", platform: process.platform, now: NOW });
await createTaskScratch({ root, taskId: "task_stale_abc003", platform: process.platform, now: NOW - SCRATCH_RETENTION_MS * 2 });
await createTaskScratch({ root, taskId: "task_running_abc004", platform: process.platform, now: NOW });
await createTaskScratch({ root, taskId: "task_unknown_abc005", platform: process.platform, now: NOW });
await createTaskScratch({ root, taskId: "task_exec_abc006", platform: process.platform, now: NOW });
await createTaskScratch({ root, taskId: "task_live_abc007", platform: process.platform, now: NOW });
await fs.mkdir(path.join(root, "task_free_abc008"));
await fs.writeFile(path.join(root, "task_free_abc008", "note.txt"), "unowned");
await record("task_done_abc001", { status: "succeeded", finished_at: "2026-10-23T11:00:00.000Z" });
await record("task_fail_abc002", { status: "failed", finished_at: "2026-10-23T11:00:00.000Z" });
await record("task_stale_abc003", { status: "failed", finished_at: "2026-10-10T11:00:00.000Z" });
await record("task_running_abc004", { status: "running" });
await record("task_unknown_abc005", { status: "failed", finished_at: "2026-10-23T11:00:00.000Z", guard_state: "unknown" });
await record("task_exec_abc006", { status: "failed", finished_at: "2026-10-23T11:00:00.000Z", execution_unknown: true });
await record("task_live_abc007", { status: "succeeded", finished_at: "2026-10-23T11:00:00.000Z" });
await createTaskScratch({ root, taskId: "task_self_abc009", platform: process.platform, now: NOW });
await record("task_self_abc009", { status: "succeeded", finished_at: "2026-10-23T11:00:00.000Z" });

const swept = await cleanupScratch({
  root, task: { id: "task_self_abc009", status: "succeeded", finished_at: "2026-10-23T11:00:00.000Z" },
  taskDirectory: tasks, platform: process.platform, now: NOW, activeIds: ["task_live_abc007"], idPattern: ID,
});
for (const removed of ["task_done_abc001", "task_stale_abc003", "task_self_abc009"]) {
  assert(swept.removed.includes(removed), "expected removed: " + removed);
  assert.equal(await fs.stat(path.join(root, removed)).then(() => true, () => false), false);
}
for (const kept of ["task_fail_abc002", "task_running_abc004", "task_live_abc007", "task_free_abc008"]) {
  assert(swept.kept.includes(kept), "expected kept: " + kept);
}
assert(swept.protected.includes("task_unknown_abc005"));
assert(swept.protected.includes("task_exec_abc006"));
assert(swept.protected.includes("task_free_abc008"));
checks.push("cleanup-protects-evidence-and-other-tasks");

// A cap applies after retention, and removes the oldest non-protected entry first.
const capRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-cap-"));
const capTasks = path.join(capRoot, "tasks");
await fs.mkdir(capTasks);
for (const [id, age] of [["task_one_abc010", 3000], ["task_two_abc011", 2000], ["task_three_abc012", 1000]]) {
  await createTaskScratch({ root: capRoot, taskId: id, platform: process.platform, now: NOW - age });
  await fs.writeFile(path.join(capTasks, id + ".json"), JSON.stringify({ id, status: "failed", finished_at: "x" }));
}
const capped = await cleanupScratch({
  root: capRoot, task: null, taskDirectory: capTasks, platform: process.platform,
  now: NOW, maxEntries: 1, maxBytes: 1024 * 1024, idPattern: ID,
});
assert.deepEqual(capped.removed.sort(), ["task_one_abc010", "task_two_abc011"]);
assert.deepEqual(capped.kept, ["task_three_abc012"]);
checks.push("cleanup-entry-cap");

// An active task is not a budget candidate, even when its record already looks finished or it
// is older than the retention period: its steps may still hold those files open.
const liveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-live-"));
const liveTasks = path.join(liveRoot, "tasks");
await fs.mkdir(liveTasks);
await createTaskScratch({
  root: liveRoot, taskId: "task_busy_abc020", platform: process.platform, now: NOW - SCRATCH_RETENTION_MS * 2,
});
await fs.writeFile(path.join(liveRoot, "task_busy_abc020", "big.bin"), Buffer.alloc(4096));
await fs.writeFile(path.join(liveTasks, "task_busy_abc020.json"),
  JSON.stringify({ id: "task_busy_abc020", status: "succeeded", finished_at: "2026-10-23T11:00:00.000Z" }));
const liveSweep = await cleanupScratch({
  root: liveRoot, task: null, activeIds: ["task_busy_abc020"], taskDirectory: liveTasks,
  platform: process.platform, now: NOW, maxEntries: 0, maxBytes: 1, idPattern: ID,
});
assert.equal(liveSweep.removed.includes("task_busy_abc020"), false);
assert(liveSweep.protected.includes("task_busy_abc020"));
assert.equal(await fs.stat(path.join(liveRoot, "task_busy_abc020", "big.bin")).then(() => true, () => false), true);
checks.push("cleanup-protects-active-task");

// A record that exists but cannot be parsed is not an orphan: it may still name an unresolved
// task, so the directory is protected. A record the store proves absent is still disposable.
const brokenRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-broken-"));
const brokenTasks = path.join(brokenRoot, "tasks");
await fs.mkdir(brokenTasks);
await createTaskScratch({
  root: brokenRoot, taskId: "task_lost_abc021", platform: process.platform, now: NOW - SCRATCH_RETENTION_MS * 2,
});
await fs.writeFile(path.join(brokenTasks, "task_lost_abc021.json"), "{\"status\":");
await createTaskScratch({
  root: brokenRoot, taskId: "task_gone_abc022", platform: process.platform, now: NOW - SCRATCH_RETENTION_MS * 2,
});
const brokenSweep = await cleanupScratch({
  root: brokenRoot, task: null, taskDirectory: brokenTasks, platform: process.platform,
  now: NOW, idPattern: ID,
});
assert.equal(brokenSweep.removed.includes("task_lost_abc021"), false);
assert(brokenSweep.protected.includes("task_lost_abc021"));
assert.equal(await fs.stat(path.join(brokenRoot, "task_lost_abc021")).then(() => true, () => false), true);
assert(brokenSweep.removed.includes("task_gone_abc022"), "a missing record is still an orphan");
checks.push("cleanup-protects-unreadable-record");

await fs.rm(liveRoot, { recursive: true, force: true });
await fs.rm(brokenRoot, { recursive: true, force: true });

// A link is skipped, not followed: deleting through it would reach a directory the owner
// record does not name. Windows may refuse link creation, in which case the branch is skipped.
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-outside-"));
await fs.writeFile(path.join(outside, "keep.txt"), "keep");
let linked = false;
try {
  await fs.symlink(outside, path.join(root, "task_link_abc013"), "dir");
  linked = true;
} catch (error) {
  if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
}
if (linked) {
  const linkSweep = await cleanupScratch({
    root, task: null, taskDirectory: tasks, platform: process.platform, now: NOW, idPattern: ID,
  });
  assert(!linkSweep.removed.includes("task_link_abc013"));
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
  checks.push("cleanup-does-not-follow-links");
}

// Replacing the root itself with a link is refused as well; cleanup reports the area as
// unavailable instead of sweeping the link target.
const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-realroot-"));
await createTaskScratch({ root: realRoot, taskId: "task_real_abc014", platform: process.platform, now: NOW });
const linkedRoot = path.join(os.tmpdir(), "thriftyrelay-scratch-linkedroot-" + process.pid);
let rootLinked = false;
try {
  await fs.symlink(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  rootLinked = true;
} catch (error) {
  if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
}
if (rootLinked) {
  const rootSweep = await cleanupScratch({
    root: linkedRoot, task: null, taskDirectory: tasks, platform: process.platform, now: NOW, idPattern: ID,
  });
  assert.equal(rootSweep.unavailable, true);
  assert.equal(await fs.stat(path.join(realRoot, "task_real_abc014")).then(() => true, () => false), true);
  checks.push("cleanup-refuses-linked-root");
}
await fs.rm(linkedRoot, { recursive: true, force: true });
await fs.rm(realRoot, { recursive: true, force: true });
assert(MAX_SCRATCH_ENTRIES >= 1);

// The task manager creates the directory before the first step, resolves relative paths
// inside it, and removes it after a confirmed success. The fake step records what admission
// would have seen; it does not write anywhere itself.
const managerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-manager-"));
const managerTasks = path.join(managerRoot, "tasks");
await fs.mkdir(managerTasks);
const seen = [];
const manager = createTaskManager({
  dir: managerTasks,
  scratchRoot: path.join(managerRoot, "temp"),
  idPattern: ID,
  taskId: () => "task_unit_abc123",
  executeStep: async step => {
    seen.push(step);
    return { result: { content: [{ type: "text", text: "ok" }] }, summary: "ok", failed: false };
  },
  textOf: result => result.content[0].text,
  compactText: text => text,
  truncate: text => text,
  redactHistory: text => text,
});
const run = await manager.run({ steps: [
  { kind: "write", path: "out/a.txt", content: "x" },
  { kind: "read", path: "{{scratch}}/out/a.txt" },
], scratch: true });
assert.equal(run.isError, undefined);
assert.equal(seen[0].path, path.join(managerRoot, "temp", "task_unit_abc123", "out", "a.txt"));
assert.equal(seen[1].path, path.join(managerRoot, "temp", "task_unit_abc123", "out", "a.txt"));
assert.equal(await fs.stat(path.join(managerRoot, "temp", "task_unit_abc123")).then(() => true, () => false), false);
const seenBeforeEscape = seen.length;
const escapedRun = await manager.run({ steps: [{ kind: "write", path: "../escape.txt", content: "x" }], scratch: true });
assert.equal(escapedRun.isError, true);
assert.match(escapedRun.content[0].text, /SCRATCH_PATH_ESCAPE/);
assert.equal(seen.length, seenBeforeEscape);
assert.equal(await fs.stat(path.join(managerRoot, "temp", "task_unit_abc123")).then(() => true, () => false), false);

// The approved path always runs asynchronously, so a retained directory has to be named in the
// summary the caller receives there too, not only in the synchronous header.
const asyncRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-async-"));
const asyncTasks = path.join(asyncRoot, "tasks");
await fs.mkdir(asyncTasks);
const asyncManager = createTaskManager({
  dir: asyncTasks, scratchRoot: path.join(asyncRoot, "temp"), idPattern: ID, taskId: () => "task_unit_fail01",
  executeStep: async () => ({ result: { content: [{ type: "text", text: "no" }] }, summary: "FAIL", failed: true }),
  textOf: result => result.content[0].text, compactText: text => text, truncate: text => text, redactHistory: text => text,
});
const failedRun = await asyncManager.run({ steps: [{ kind: "run", command: "fail" }], scratch: true, execution: "async" });
assert.equal(failedRun.isError, undefined);
const failedInfo = await asyncManager.inspect({ task_id: "task_unit_fail01", wait_ms: 5000 });
assert.match(failedInfo.content[0].text, /Scratch retained: .*task_unit_fail01/);
assert.equal(await fs.stat(path.join(asyncRoot, "temp", "task_unit_fail01")).then(() => true, () => false), true);
await fs.rm(asyncRoot, { recursive: true, force: true });

const noRoot = createTaskManager({
  dir: managerTasks, idPattern: ID, taskId: () => "task_unit_def456",
  executeStep: async () => ({ result: { content: [{ type: "text", text: "ok" }] }, summary: "ok", failed: false }),
  textOf: result => result.content[0].text, compactText: text => text, truncate: text => text, redactHistory: text => text,
});
const unavailable = await noRoot.run({ steps: [{ kind: "read", path: "a.txt" }], scratch: true });
assert.equal(unavailable.isError, true);
assert.match(unavailable.content[0].text, /SCRATCH_UNAVAILABLE/);
checks.push("task-manager-creates-and-cleans-scratch");

await fs.rm(managerRoot, { recursive: true, force: true });

// History pruning must not drop the record that keeps recovery evidence alive: the sweep would
// then classify the directory as an unowned orphan and age the recovery files out. This drives
// the manager's own completion path so the two rules are checked together.
const recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-recovery-"));
const recoveryTasks = path.join(recoveryRoot, "tasks");
const recoveryTemp = path.join(recoveryRoot, "temp");
await fs.mkdir(recoveryTasks);
await fs.mkdir(recoveryTemp);
const recoveries = [
  ["task_aaa_aaaaaa", { status: "failed", finished_at: "2026-10-20T11:00:00.000Z", guard_state: "recovered", recovery: { audit_id: "recovery-1" } }],
  ["task_aab_aaaaaa", { status: "failed", finished_at: "2026-10-20T11:00:00.000Z", execution_unknown: true, recovery: true }],
];
for (const [id, fields] of recoveries) {
  await createTaskScratch({
    root: recoveryTemp, taskId: id, platform: process.platform, now: NOW - SCRATCH_RETENTION_MS * 2,
  });
  await fs.writeFile(path.join(recoveryTasks, id + ".json"), JSON.stringify({ id, ...fields }));
}
for (let index = 0; index < 101; index++) {
  const id = "task_b" + String(index).padStart(2, "0") + "_bbb" + String(index).padStart(3, "0");
  await fs.writeFile(path.join(recoveryTasks, id + ".json"),
    JSON.stringify({ id, status: "failed", finished_at: "2026-10-20T11:00:00.000Z" }));
}
const recoveryManager = createTaskManager({
  dir: recoveryTasks, idPattern: ID, taskId: () => "task_new_zzzzzz", scratchRoot: recoveryTemp,
  executeStep: async () => ({ result: { content: [{ type: "text", text: "ok" }] }, summary: "ok", failed: false }),
  textOf: result => result.content[0].text, compactText: text => text, truncate: text => text, redactHistory: text => text,
});
const pruneRun = await recoveryManager.run({ steps: [{ kind: "read", path: "a.txt" }] });
assert.equal(pruneRun.isError, undefined);
const recoverySweep = await cleanupScratch({
  root: recoveryTemp, task: null, taskDirectory: recoveryTasks, platform: process.platform, now: NOW, idPattern: ID,
});
for (const [id] of recoveries) {
  assert.equal(recoverySweep.removed.includes(id), false, "recovery scratch removed: " + id);
  assert(recoverySweep.protected.includes(id));
  assert.equal(await fs.stat(path.join(recoveryTemp, id)).then(() => true, () => false), true);
}
const history = (await fs.readdir(recoveryTasks)).filter(name => name.endsWith(".json"));
assert.equal(history.length, 100, "history cap still applies: " + history.length);
for (const [id] of recoveries) assert(history.includes(id + ".json"), "recovery record pruned: " + id);
checks.push("recovery-evidence-survives-history-pruning");
await fs.rm(recoveryRoot, { recursive: true, force: true });

await fs.rm(capRoot, { recursive: true, force: true });
await fs.rm(outside, { recursive: true, force: true });
await fs.rm(root, { recursive: true, force: true });
console.log("PASS: " + checks.join(", "));
