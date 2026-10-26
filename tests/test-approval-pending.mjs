import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approvalForTask, consumeWindow, openWindow } from "../src/mcp/approval.mjs";
import {
  claimPending, closePending, createPending, expirePending, finishPending, listPending,
  DECISION_RETENTION_MS, MAX_DECISIONS,
  readClaimed, readDecision, readPending, restorePending, scanPending, scratchRootChanged,
} from "../src/mcp/approval-pending.mjs";

// The card and the execution must not be able to disagree, so the submission is stored as the
// operation itself, claimed by one approval, and the task's tier is read back from the window
// it spent rather than remembered in the process. Expiry is part of claiming: listing may
// report an expired record, but only a claim may turn it into a terminal decision.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-pending-"));
const now = Date.parse("2026-10-19T09:00:00.000Z");
const policy = {
  generation: 7,
  kill_switch: false,
  full_access: { mode: "window", max_minutes: 30, max_concurrent: 2 },
  tunnel_ids: [],
  workspace_roots: [],
  protected_paths: [],
};
const checks = [];

// The stored record is what runs, and listing shows it until it is claimed.
const args = { steps: [{ kind: "run", command: "npm test", expose: false }], stop_on_error: true, execution: "sync" };
const binding = "b".repeat(64);
await createPending({ directory: root, taskId: "task_aaa111", binding, args, now });
assert.equal((await readPending({ directory: root, taskId: "task_aaa111" })).binding, binding);
assert.equal((await listPending({ directory: root, now: now + 1000 })).length, 1);
checks.push("pending-roundtrip");

// One approval starts one task: the second claim finds nothing, and a refusal can return it.
const claimed = await claimPending({ directory: root, taskId: "task_aaa111", now });
assert.equal(claimed.state, "claimed");
assert.equal(claimed.record.args.steps[0].command, "npm test");
assert.equal((await claimPending({ directory: root, taskId: "task_aaa111", now })).state, "missing");
assert.equal((await listPending({ directory: root, now: now + 1000 })).length, 0);
await restorePending({ directory: root, taskId: "task_aaa111" });
assert.equal((await listPending({ directory: root, now: now + 1000 })).length, 1);
await claimPending({ directory: root, taskId: "task_aaa111", now });
await finishPending({ directory: root, taskId: "task_aaa111" });
assert.equal(await readPending({ directory: root, taskId: "task_aaa111" }), null);
checks.push("claim-is-single-use");

// Reading a stale list must not delete the record; the expiry path claims first and writes the
// terminal decision, so a concurrent approval can only win or lose the same rename.
await createPending({ directory: root, taskId: "task_bbb222", binding, args, now });
const staleScan = await scanPending({ directory: root, now: now + 11 * 60_000 });
assert.equal(staleScan.items.length, 0);
assert.equal(staleScan.expired.length, 1);
assert.notEqual(await readPending({ directory: root, taskId: "task_bbb222" }), null);
const expired = await expirePending({ directory: root, taskId: "task_bbb222", now: now + 11 * 60_000 });
assert.equal(expired.state, "expired");
assert.equal((await readDecision({ directory: root, taskId: "task_bbb222" })).outcome, "expired");
assert.equal(await readPending({ directory: root, taskId: "task_bbb222" }), null);
assert.equal(await readClaimed({ directory: root, taskId: "task_bbb222" }), null);
checks.push("expiry-claims-then-records");

// A claim already past its ttl cannot be approved: the caller closes the record it holds and
// does not try to claim a second time.
await createPending({ directory: root, taskId: "task_ccc111", binding, args, now });
const late = await claimPending({ directory: root, taskId: "task_ccc111", now: now + 11 * 60_000 });
assert.equal(late.state, "expired");
const closedLate = await closePending({
  directory: root, taskId: "task_ccc111", record: late.record, outcome: "expired", now: now + 11 * 60_000,
});
assert.equal(closedLate.ok, true);
assert.equal((await readDecision({ directory: root, taskId: "task_ccc111" })).outcome, "expired");
assert.equal(await readClaimed({ directory: root, taskId: "task_ccc111" }), null);
checks.push("expired-claim-closes-without-reclaiming");

// A decline is terminal, leaves no window, and the record says why.
await createPending({ directory: root, taskId: "task_ddd222", binding, args, now });
const toDecline = await claimPending({ directory: root, taskId: "task_ddd222", now });
assert.equal(toDecline.state, "claimed");
const declined = await closePending({ directory: root, taskId: "task_ddd222", record: toDecline.record, outcome: "declined", now });
assert.equal(declined.ok, true);
assert.equal((await readDecision({ directory: root, taskId: "task_ddd222" })).outcome, "declined");
assert.equal(await readClaimed({ directory: root, taskId: "task_ddd222" }), null);
assert.equal((await claimPending({ directory: root, taskId: "task_ddd222", now })).state, "missing");
checks.push("decline-is-terminal");

// If the decision cannot be written, the claimed record stays claimed: the submission is not
// returned to an approvable state, and a later attempt can still record the reason.
const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-pending-blocked-"));
await createPending({ directory: blockedRoot, taskId: "task_eee333", binding, args, now });
const blocked = await claimPending({ directory: blockedRoot, taskId: "task_eee333", now });
await fs.writeFile(path.join(blockedRoot, "decisions"), "not a directory");
const failed = await closePending({ directory: blockedRoot, taskId: "task_eee333", record: blocked.record, outcome: "declined", now });
assert.equal(failed.ok, false);
assert.notEqual(await readClaimed({ directory: blockedRoot, taskId: "task_eee333" }), null);
assert.equal(await readPending({ directory: blockedRoot, taskId: "task_eee333" }), null);
assert.equal((await claimPending({ directory: blockedRoot, taskId: "task_eee333", now })).state, "missing");
await fs.rm(path.join(blockedRoot, "decisions"), { force: true });
const retried = await closePending({ directory: blockedRoot, taskId: "task_eee333", record: blocked.record, outcome: "declined", now });
assert.equal(retried.ok, true);
assert.equal((await readDecision({ directory: blockedRoot, taskId: "task_eee333" })).outcome, "declined");
await fs.rm(blockedRoot, { recursive: true, force: true });
checks.push("decision-failure-does-not-restore");

// A duplicate pending file must not overwrite an unresolved claim. Two normal callers still
// get one winner.
await createPending({ directory: root, taskId: "task_conflict", binding, args, now });
const unresolved = await claimPending({ directory: root, taskId: "task_conflict", now });
await createPending({ directory: root, taskId: "task_conflict", binding: "different", args, now });
assert.equal((await claimPending({ directory: root, taskId: "task_conflict", now })).state, "conflict");
assert.equal((await readClaimed({ directory: root, taskId: "task_conflict" })).binding, unresolved.record.binding);
assert.notEqual(await readPending({ directory: root, taskId: "task_conflict" }), null);
await createPending({ directory: root, taskId: "task_race", binding, args, now });
const raced = await Promise.all([
  claimPending({ directory: root, taskId: "task_race", now }),
  claimPending({ directory: root, taskId: "task_race", now }),
]);
assert.equal(raced.filter(result => result.state === "claimed").length, 1);
checks.push("conflict-preserves-claim-and-race-has-one-winner");

// Completed decisions are bounded independently of unresolved claims.
const decisionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-decision-limit-"));
await fs.mkdir(path.join(decisionRoot, "decisions"));
for (let i = 0; i < MAX_DECISIONS + 1; i++) {
  const id = "task_history_" + i;
  await fs.writeFile(path.join(decisionRoot, "decisions", id + ".json"), JSON.stringify({
    task_id: id, outcome: "declined", binding, at: new Date(now - i - 1).toISOString(),
  }));
}
await fs.writeFile(path.join(decisionRoot, "decisions", "task_old.json"), JSON.stringify({
  task_id: "task_old", outcome: "expired", binding, at: new Date(now - DECISION_RETENTION_MS - 1).toISOString(),
}));
await createPending({ directory: decisionRoot, taskId: "task_new", binding, args, now });
const newClaim = await claimPending({ directory: decisionRoot, taskId: "task_new", now });
await closePending({ directory: decisionRoot, taskId: "task_new", record: newClaim.record, outcome: "declined", now });
assert.equal((await fs.readdir(path.join(decisionRoot, "decisions"))).length, MAX_DECISIONS);
assert.equal(await readDecision({ directory: decisionRoot, taskId: "task_old" }), null);
assert.notEqual(await readDecision({ directory: decisionRoot, taskId: "task_new" }), null);
await fs.rm(decisionRoot, { recursive: true, force: true });
checks.push("decision-age-and-count-are-bounded");

// Only a scratch submission is tied to the temporary root it was planned against.
const scratch = { args: { scratch: true }, scratch_root: "C:\\temp\\one" };
const same = (left, right) => left === right;
assert.equal(scratchRootChanged({ record: scratch, currentRoot: "C:\\temp\\one", samePath: same }), false);
assert.equal(scratchRootChanged({ record: scratch, currentRoot: "C:\\temp\\two", samePath: same }), true);
assert.equal(scratchRootChanged({ record: scratch, currentRoot: "", samePath: same }), true);
assert.equal(scratchRootChanged({ record: { args: { scratch: false } }, currentRoot: "C:\\temp\\two", samePath: same }), false);
assert.equal(scratchRootChanged({ record: { args: {} }, currentRoot: "C:\\temp\\two", samePath: same }), false);
checks.push("scratch-root-is-part-of-the-plan");

// The tier a step runs at comes from the spent window: same generation, same task, unexpired.
await openWindow({ directory: root, policy, minutes: 10, task: { id: "task_fff444" }, binding, now });
await consumeWindow({ directory: root, taskId: "task_fff444", binding, policy, now });
const approved = await approvalForTask({ directory: root, taskId: "task_fff444", policy, now: now + 60_000 });
assert.equal(approved.task_id, "task_fff444");
assert.equal(approved.binding, binding);
assert.equal(await approvalForTask({ directory: root, taskId: "task_fff444", policy, now: now + 11 * 60_000 }), null);
assert.equal(await approvalForTask({ directory: root, taskId: "task_fff444", policy: { ...policy, generation: 8 }, now }), null);
assert.equal(await approvalForTask({ directory: root, taskId: "task_fff444", policy: { ...policy, kill_switch: true }, now }), null);
assert.equal(await approvalForTask({ directory: root, taskId: "task_other", policy, now }), null);
checks.push("task-tier-follows-the-window");

await fs.rm(root, { recursive: true, force: true });
console.log("PASS: " + checks.join(", "));
