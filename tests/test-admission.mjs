import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { admissionState, evaluateStep, evaluateStepResolved, recordRefusal, resolveTargetPath, sandboxForTier, targetsOf } from "../src/mcp/admission.mjs";

// Every step is admitted in one place, so these assertions are the whole permission surface:
// which kind of step needs which tier, and which path kinds override that answer.

const WIN = {
  platform: "win32",
  home: "C:\\Users\\fixture",
  appDirectory: "C:\\app",
  env: {
    ProgramData: "C:\\ProgramData",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    SystemRoot: "C:\\Windows",
  },
};
const POLICY = {
  generation: 3,
  kill_switch: false,
  full_access: { mode: "window", max_minutes: 30, max_concurrent: 1 },
  tunnel_ids: ["tunnel_0123456789abcdef0123456789abcdef"],
  workspace_roots: ["C:\\work"],
  protected_paths: ["C:\\tunnel-client"],
};
const decide = (step, tier) => evaluateStep({ ...WIN, step, policy: POLICY, tier });
const checks = [];

// A host that was never registered keeps the behaviour it had; the decision says so instead of
// pretending it was checked.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-admission-"));
const missing = await admissionState({ file: path.join(root, "absent", "policy.json") });
assert.equal(missing.status, "unregistered");
const legacy = evaluateStep({ ...WIN, step: { kind: "run", command: "npm test" }, policy: null, tier: "standard" });
assert.equal(legacy.allowed, true);
assert.equal(legacy.enforcement, "none");
checks.push("unregistered-keeps-behaviour");

// Inside the workspace the normal working mode needs no window, for reads and writes alike.
for (const step of [
  { kind: "read", path: "C:\\work\\src\\app.js" },
  { kind: "write", path: "C:\\work\\src\\app.js", content: "x" },
  { kind: "edit", file_path: "C:\\work\\src\\app.js", old_string: "a", new_string: "b" },
  { kind: "patch", files: [{ path: "C:\\work\\src\\a.js", edits: [] }] },
]) {
  assert.equal(decide(step, "standard").allowed, true, step.kind);
}
checks.push("workspace-is-normal-mode");

// The MCP's own files, the registration and the paths it records are write-denied at every
// tier; reading them stays possible, because a fix may need to read the config.
for (const target of ["C:\\ProgramData\\ThriftyRelay\\policy.json", "C:\\app\\src\\server.mjs", "C:\\tunnel-client\\tunnel.exe"]) {
  assert.equal(decide({ kind: "read", path: target }, "full").allowed, true, target);
  assert.deepEqual(decide({ kind: "write", path: target, content: "" }, "full"), {
    allowed: false, code: "ADMISSION_PROTECTED_PATH", detail: target,
  });
}
// A patch is one operation over several files, so one protected target is enough to refuse it.
const mixed = decide({
  kind: "patch",
  files: [{ path: "C:\\work\\a.js", edits: [] }, { path: "C:\\app\\index.mjs", edits: [] }],
}, "full");
assert.equal(mixed.allowed, false);
assert.equal(mixed.code, "ADMISSION_PROTECTED_PATH");
checks.push("protected-paths-are-write-denied");

// Sensitive paths and paths outside every root both need the tier that a registration can
// grant, which is where the user's approval enters the decision.
for (const target of ["C:\\work\\.env", "C:\\Users\\fixture\\.ssh\\id_ed25519", "D:\\other\\notes.txt"]) {
  assert.equal(decide({ kind: "read", path: target }, "standard").allowed, false, target);
  assert.equal(decide({ kind: "read", path: target }, "full").allowed, true, target);
}
assert.equal(decide({ kind: "read", path: "C:\\work\\.env" }, "standard").code, "ADMISSION_APPROVAL_REQUIRED");
assert.equal(decide({ kind: "read", path: "D:\\other\\notes.txt" }, "standard").code, "ADMISSION_OUTSIDE_WORKSPACE");
checks.push("sensitive-and-outside-need-full");

// Kinds a path rule cannot describe run only at full access. This is the check that keeps a
// standard registration from turning into a shell.
for (const step of [
  { kind: "run", command: "npm test" },
  { kind: "call", tool: "read_file", arguments: {} },
  { kind: "code", code: "return 1" },
]) {
  assert.equal(decide(step, "standard").allowed, false, step.kind);
  assert.equal(decide(step, "standard").code, "ADMISSION_TIER_REQUIRED", step.kind);
  assert.equal(decide(step, "full").allowed, true, step.kind);
}
checks.push("privileged-kinds-need-full");

// codex is converted rather than denied: the SDK sandbox is the boundary, so the tier picks it.
for (const [tier, expected] of [["standard", "read-only"], ["trusted", "workspace-write"], ["full", "danger-full-access"]]) {
  const decision = decide({ kind: "codex", prompt: "x", cwd: "C:\\work" }, tier);
  assert.equal(decision.allowed, true, tier);
  assert.equal(decision.sandbox, expected, tier);
}
assert.equal(sandboxForTier("standard"), "read-only");
assert.equal(sandboxForTier("trusted"), "workspace-write");
assert.equal(sandboxForTier("full"), "danger-full-access");
checks.push("codex-sandbox-follows-the-tier");

// Only the paths the server knows before execution are classified; a shell is not one of them.
assert.deepEqual(targetsOf({ kind: "read", path: "a" }), ["a"]);
assert.deepEqual(targetsOf({ kind: "edit", file_path: "b" }), ["b"]);
assert.deepEqual(targetsOf({ kind: "patch", files: [{ path: "c" }, { path: "d" }] }), ["c", "d"]);
assert.deepEqual(targetsOf({ kind: "run", command: "rm -rf /" }), []);
checks.push("auditable-targets");

// A registered scratch root removes the window for ordinary file steps, but not for the kinds
// that run caller-supplied code, and not for a sensitive name copied into it.
const SCRATCH_POLICY = { ...POLICY, scratch_roots: ["C:\\work\\scratch"] };
const scratchDecide = (step, tier) => evaluateStep({ ...WIN, step, policy: SCRATCH_POLICY, tier });
for (const step of [
  { kind: "read", path: "C:\\work\\scratch\\a.bin" },
  { kind: "write", path: "C:\\work\\scratch\\a.bin", content: "x" },
  { kind: "edit", file_path: "C:\\work\\scratch\\a.txt", old_string: "a", new_string: "b" },
  { kind: "patch", files: [{ path: "C:\\work\\scratch\\a.js", edits: [] }] },
]) {
  assert.equal(scratchDecide(step, "standard").allowed, true, step.kind);
}
assert.equal(scratchDecide({ kind: "run", command: "npm test" }, "standard").code, "ADMISSION_TIER_REQUIRED");
assert.equal(scratchDecide({ kind: "code", code: "return 1" }, "standard").code, "ADMISSION_TIER_REQUIRED");
assert.equal(scratchDecide({ kind: "read", path: "C:\\work\\scratch\\.env" }, "standard").code,
  "ADMISSION_APPROVAL_REQUIRED");
checks.push("scratch-is-normal-mode-only-for-file-steps");

// Real paths, not spellings: a link that leaves the scratch root is judged by its target.
const realScratch = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-scratch-admission-"));
const realPolicy = { workspace_roots: [], scratch_roots: [realScratch], protected_paths: [] };
const taskA = path.join(realScratch, "task_a_abc123");
const taskB = path.join(realScratch, "task_b_def456");
await fs.mkdir(taskA);
await fs.mkdir(taskB);
await fs.mkdir(path.join(realScratch, "app"));
await fs.writeFile(path.join(taskA, "owner.json"), JSON.stringify({ version: 1, task_id: "task_a_abc123" }));
await fs.writeFile(path.join(taskB, "owner.json"), JSON.stringify({ version: 1, task_id: "task_b_def456" }));
await fs.writeFile(path.join(taskA, "a.txt"), "a");
await fs.writeFile(path.join(taskB, "b.txt"), "b");
const own = await evaluateStepResolved({
  step: { kind: "read", path: path.join(taskA, "a.txt") }, policy: realPolicy, tier: "standard",
  appDirectory: path.join(realScratch, "app"), home: os.homedir(), taskId: "task_a_abc123",
});
assert.equal(own.allowed, true);
const foreign = await evaluateStepResolved({
  step: { kind: "read", path: path.join(taskB, "b.txt") }, policy: realPolicy, tier: "standard",
  appDirectory: path.join(realScratch, "app"), home: os.homedir(), taskId: "task_a_abc123",
});
assert.equal(foreign.code, "ADMISSION_SCRATCH_OTHER_TASK");
const foreignFull = await evaluateStepResolved({
  step: { kind: "read", path: path.join(taskB, "b.txt") }, policy: realPolicy, tier: "full",
  appDirectory: path.join(realScratch, "app"), home: os.homedir(), taskId: "task_a_abc123",
});
assert.equal(foreignFull.allowed, true);
const unownedDir = path.join(realScratch, "task_c_ghi789");
await fs.mkdir(unownedDir);
const unowned = await evaluateStepResolved({
  step: { kind: "read", path: path.join(unownedDir, "c.txt") }, policy: realPolicy, tier: "standard",
  appDirectory: path.join(realScratch, "app"), home: os.homedir(), taskId: "task_a_abc123",
});
assert.equal(unowned.code, "ADMISSION_SCRATCH_OWNER_UNKNOWN");
// A root-level file is not a task directory, so it remains an ordinary scratch path.
const shared = path.join(realScratch, "shared.txt");
await fs.writeFile(shared, "shared");
const sharedRead = await evaluateStepResolved({
  step: { kind: "read", path: shared }, policy: realPolicy, tier: "standard",
  appDirectory: path.join(realScratch, "app"), home: os.homedir(), taskId: "task_a_abc123",
});
assert.equal(sharedRead.allowed, true);
// Naming the root itself would let a search walk every sibling task, so it is refused at the
// same tier as a foreign task directory instead of passing the per-target owner check.
for (const spelling of [realScratch, realScratch + path.sep]) {
  const rootRead = await evaluateStepResolved({
    step: { kind: "read", path: spelling }, policy: realPolicy, tier: "standard",
    appDirectory: path.join(realScratch, "app"), home: os.homedir(), taskId: "task_a_abc123",
  });
  assert.equal(rootRead.code, "ADMISSION_SCRATCH_ROOT_SCOPE", spelling);
}
const rootSearch = await evaluateStepResolved({
  step: { kind: "search", path: realScratch, pattern: "b" }, policy: realPolicy, tier: "standard",
  appDirectory: path.join(realScratch, "app"), home: os.homedir(), taskId: "task_a_abc123",
});
assert.equal(rootSearch.code, "ADMISSION_SCRATCH_ROOT_SCOPE");
const rootFull = await evaluateStepResolved({
  step: { kind: "search", path: realScratch, pattern: "b" }, policy: realPolicy, tier: "full",
  appDirectory: path.join(realScratch, "app"), home: os.homedir(), taskId: "task_a_abc123",
});
assert.equal(rootFull.allowed, true);
checks.push("scratch-task-isolation");

// A symlink inside the root pointing to a protected location must not inherit scratch's
// approval-free rule. Creating a link can be denied on Windows, so the check is skipped only
// when the platform refuses the setup operation, not when the assertion fails.
const link = path.join(taskA, "escape");
let linkCreated = false;
try {
  await fs.symlink(path.join(realScratch, "app"), link, "dir");
  linkCreated = true;
} catch (error) {
  if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
}
if (linkCreated) {
  const escaped = await evaluateStepResolved({
    step: { kind: "write", path: path.join(link, "server.mjs"), content: "x" },
    policy: realPolicy, tier: "standard", appDirectory: path.join(realScratch, "app"),
    home: os.homedir(), taskId: "task_a_abc123",
  });
  assert.equal(escaped.allowed, false);
  assert.equal(escaped.code, "ADMISSION_PROTECTED_PATH");
  checks.push("scratch-link-escape");
}
assert.equal(await resolveTargetPath(path.join(taskA, "missing", "file.txt")),
  path.join(await fs.realpath(taskA), "missing", "file.txt"));

await fs.rm(realScratch, { recursive: true, force: true });


// A refusal is recorded with what was attempted and why it stopped, never with the content.
await recordRefusal({
  code: "ADMISSION_PROTECTED_PATH", detail: "C:\\app\\index.mjs", kind: "write",
  taskId: "task_test_abc123", directory: root, now: Date.parse("2026-10-19T12:00:00.000Z"),
});
const entries = (await fs.readFile(path.join(root, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
assert.deepEqual(entries, [{
  at: "2026-10-19T12:00:00.000Z", event: "admission.refused", reason: "ADMISSION_PROTECTED_PATH",
  kind: "write", task_id: "task_test_abc123", target: "C:\\app\\index.mjs",
}]);
checks.push("refusals-are-recorded");

await fs.rm(root, { recursive: true, force: true });
console.log("PASS: " + checks.join(", "));
