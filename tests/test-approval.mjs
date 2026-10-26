import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activeWindows, approvalDirectory, bindingHash, closeWindows, consumeWindow, dayKey, openWindow, windowStatus,
} from "../src/mcp/approval.mjs";

// The window is the only thing a card can create, so its limits and its single use are the
// part of the approval face that must not depend on the caller behaving. These assertions
// drive the store directly, without a server, because that is also how a second process
// reaches it.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-approval-"));
const store = path.join(root, "approval");
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE = 60_000;
const policy = {
  generation: 1,
  kill_switch: false,
  full_access: { mode: "window", max_minutes: 30, max_concurrent: 1 },
};
const checks = [];
const rejects = (promise, code) => assert.rejects(promise, { code });

// Without a registration that offers windows there is nothing to open, including when the
// policy is missing entirely (design 2.6.2).
await rejects(openWindow({ directory: store, policy: null, minutes: 10, task: { id: "a" }, now: NOW }), "APPROVAL_WINDOW_NOT_PERMITTED");
await rejects(openWindow({
  directory: store, policy: { ...policy, full_access: { ...policy.full_access, mode: "denied" } },
  minutes: 10, task: { id: "a" }, now: NOW,
}), "APPROVAL_WINDOW_NOT_PERMITTED");
// A kill switch stops new permissions, not only running ones.
await rejects(openWindow({ directory: store, policy: { ...policy, kill_switch: true }, minutes: 10, task: { id: "a" }, now: NOW }), "APPROVAL_KILL_SWITCH");
checks.push("refuses-without-permission");

for (const minutes of [0, -5, 1.5, "30", null]) {
  await rejects(openWindow({ directory: store, policy, minutes, task: { id: "a" }, now: NOW }), "APPROVAL_WINDOW_INVALID");
}
await rejects(openWindow({ directory: store, policy, minutes: 31, task: { id: "a" }, now: NOW }), "APPROVAL_WINDOW_TOO_LONG");
await rejects(openWindow({ directory: store, policy, minutes: 10, task: {}, now: NOW }), "APPROVAL_TASK_REQUIRED");
// The approval covers exactly the operation set the card displayed; without it there is
// nothing to bind, and the window could be spent on anything.
await rejects(openWindow({ directory: store, policy, minutes: 10, task: { id: "a" }, binding: "", now: NOW }), "APPROVAL_BINDING_REQUIRED");
checks.push("rejects-unusable-lengths");

const binding = bindingHash({ steps: ["run"], command: "npm test" });
const first = await openWindow({
  directory: store, policy, minutes: 30,
  task: { id: "task-a", request_id: "req-1" }, binding, now: NOW,
});
assert.equal(first.state, "open");
assert.equal(first.expires_at, new Date(NOW + 30 * MINUTE).toISOString());
assert.equal((await activeWindows({ directory: store, policy, now: NOW + 10 * MINUTE })).length, 1);
// The end is exclusive: a window whose end has arrived is closed, not still usable.
assert.equal((await activeWindows({ directory: store, policy, now: NOW + 30 * MINUTE })).length, 0);
const status = await windowStatus({ directory: store, policy, now: NOW + 5 * MINUTE });
assert.equal(status.open, true);
assert.equal(status.windows[0].remaining_ms, 25 * MINUTE);
assert.equal(status.windows[0].task_id, "task-a");
checks.push("window-lifetime");

await rejects(openWindow({
  directory: store, policy, minutes: 10, task: { id: "task-b" },
  binding: bindingHash({ steps: ["read"], path: "b.md" }), now: NOW,
}), "APPROVAL_WINDOW_CONCURRENT_LIMIT");
checks.push("concurrent-limit");

// Spending: the binding must match, the task must match, and the window survives a failed
// attempt so a correct retry can still spend it.
await rejects(consumeWindow({ directory: store, taskId: "task-b", policy, now: NOW }), "APPROVAL_WINDOW_NOT_FOUND");
await rejects(consumeWindow({
  directory: store, taskId: "task-a", binding: bindingHash({ steps: ["run"], command: "npm test " }), policy, now: NOW,
}), "APPROVAL_BINDING_MISMATCH");
assert.equal((await activeWindows({ directory: store, policy, now: NOW })).length, 1);
const consumed = await consumeWindow({ directory: store, taskId: "task-a", binding, policy, now: NOW });
assert.equal(consumed.state, "consumed");
assert.equal((await activeWindows({ directory: store, policy, now: NOW })).length, 0);
await rejects(consumeWindow({ directory: store, taskId: "task-a", binding, policy, now: NOW }), "APPROVAL_WINDOW_ALREADY_CONSUMED");
checks.push("single-use");

const secondBinding = bindingHash({ steps: ["read"], path: "notes.md" });
const second = await openWindow({ directory: store, policy, minutes: 5, task: { id: "task-c" }, binding: secondBinding, now: NOW });
await closeWindows({ directory: store, windowId: second.id, reason: "task-finished", now: NOW + MINUTE });
assert.equal((await activeWindows({ directory: store, policy, now: NOW })).length, 0);
assert.equal((await windowStatus({ directory: store, policy, now: NOW })).open, false);
const nextBinding = bindingHash({ steps: ["read"], path: "next.md" });
const next = await openWindow({
  directory: store, policy, minutes: 5, task: { id: "task-d" }, binding: nextBinding, now: NOW,
});
assert.equal(next.state, "open");
checks.push("closing-frees-concurrent-slot");

// Moving the registration forward revokes what the previous generation granted, including
// windows that are still inside their time (design 2.6.2).
const revoked = { ...policy, generation: 2 };
assert.equal((await activeWindows({ directory: store, policy: revoked, now: NOW + MINUTE })).length, 0);
await rejects(consumeWindow({ directory: store, taskId: "task-d", policy: revoked, now: NOW + MINUTE }), "APPROVAL_WINDOW_REVOKED");
assert.equal((await activeWindows({ directory: store, policy, now: NOW + MINUTE })).length, 1);
await consumeWindow({ directory: store, taskId: "task-d", binding: nextBinding, policy, now: NOW + MINUTE });
checks.push("generation-revocation");

// A window is not a permission that outlives the registration: a kill switch or a narrowed
// mode applies at the moment it is spent, not only when it was issued (design 2.6.8).
const store2 = path.join(root, "approval-gate");
const gatePolicy = { ...policy, full_access: { mode: "window", max_minutes: 30, max_concurrent: 2 } };
const gateBinding = bindingHash({ steps: ["run"], command: "npm test" });
await openWindow({ directory: store2, policy: gatePolicy, minutes: 10, task: { id: "gate" }, binding: gateBinding, now: NOW });
await rejects(consumeWindow({
  directory: store2, taskId: "gate", binding: gateBinding, policy: { ...gatePolicy, kill_switch: true }, now: NOW,
}), "APPROVAL_KILL_SWITCH");
await rejects(consumeWindow({
  directory: store2, taskId: "gate", binding: gateBinding,
  policy: { ...gatePolicy, full_access: { mode: "denied" } }, now: NOW,
}), "APPROVAL_WINDOW_NOT_PERMITTED");
// Without a registration there is no generation to match, so no window grants anything.
assert.equal((await activeWindows({ directory: store2, now: NOW })).length, 0);
// A refused consumption does not spend the window.
assert.equal((await activeWindows({ directory: store2, policy: gatePolicy, now: NOW })).length, 1);
await consumeWindow({ directory: store2, taskId: "gate", binding: gateBinding, policy: gatePolicy, now: NOW });
checks.push("registration-applies-at-consumption");

// Two processes asking at the same moment must not both get a window: the count and the write
// happen under one lock, not as a read followed by a write.
const store3 = path.join(root, "approval-race");
const racePolicy = { ...policy, full_access: { mode: "window", max_minutes: 30, max_concurrent: 1 } };
const raceBinding = bindingHash({ steps: ["run"], command: "npm test" });
const race = await Promise.allSettled([
  openWindow({ directory: store3, policy: racePolicy, minutes: 5, task: { id: "race-a" }, binding: raceBinding, now: NOW }),
  openWindow({ directory: store3, policy: racePolicy, minutes: 5, task: { id: "race-b" }, binding: raceBinding, now: NOW }),
]);
assert.deepEqual(race.map(result => result.status).sort(), ["fulfilled", "rejected"]);
assert.equal(race.find(result => result.status === "rejected").reason.code, "APPROVAL_WINDOW_CONCURRENT_LIMIT");
checks.push("limits-hold-under-concurrency");

// Existing policies and historical counters must not restore the removed daily limit.
const store4 = path.join(root, "approval-no-daily-limit");
const legacyPolicy = { ...policy, full_access: { ...policy.full_access, max_per_day: 1 } };
const historicalCounters = JSON.stringify({ day: dayKey(NOW), opened: 1000000 });
await fs.mkdir(store4);
await fs.writeFile(path.join(store4, "counters.json"), historicalCounters);
for (let index = 0; index < 6; index++) {
  const taskId = "unlimited-" + index;
  await openWindow({ directory: store4, policy: legacyPolicy, minutes: 5, task: { id: taskId }, binding, now: NOW });
  await consumeWindow({ directory: store4, policy: legacyPolicy, taskId, binding, now: NOW });
}
assert.equal(await fs.readFile(path.join(store4, "counters.json"), "utf8"), historicalCounters);
assert.equal((await activeWindows({ directory: store4, policy: legacyPolicy, now: NOW })).length, 0);
checks.push("no-daily-limit-with-legacy-policy-and-counters");

// The audit answers "when, what, for which task" without carrying the command text itself.
const audit = (await fs.readFile(path.join(store, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
assert(audit.some(entry => entry.event === "window.opened"));
assert(audit.some(entry => entry.event === "window.consumed"));
assert(audit.some(entry => entry.event === "window.closed" && entry.reason === "task-finished"));
assert(audit.some(entry => entry.event === "window.refused" && entry.reason === "APPROVAL_BINDING_MISMATCH"));
assert(audit.every(entry => !("command" in entry) && !("content" in entry)));
checks.push("audit-record");

// A binding is a hash of the displayed facts, so it must not depend on key order.
assert.equal(bindingHash({ b: 2, a: [1, { d: 4, c: 3 }] }), bindingHash({ a: [1, { c: 3, d: 4 }], b: 2 }));
assert.notEqual(bindingHash({ a: 1 }), bindingHash({ a: 2 }));
assert.equal(bindingHash({ a: undefined }), bindingHash({ a: null }));
checks.push("binding-hash");

// The store sits under the task directory of the host platform, which access.mjs protects.
assert.equal(
  approvalDirectory({ platform: "win32", env: { THRIFTYRELAY_TASK_DIR: "C:\\store" }, home: "C:\\Users\\f" }),
  path.join("C:\\store", "approval"),
);
checks.push("store-location");

await fs.rm(root, { recursive: true, force: true });
console.log("PASS: " + checks.join(", "));
