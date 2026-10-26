import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The card is a decision surface, not a second execution path. This suite drives the real
// server through the three outcomes that must stay distinct: decline (nothing runs, no window),
// approve (one task, one window), and a restart that changes the scratch root (invalidated,
// nothing runs). The first submission is only used to inspect what the card would show; its
// body must be fetched separately and must not be duplicated into the pending record.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-approval-decline-"));
const tasks = path.join(root, "tasks");
const workspace = path.join(root, "workspace");
const scratchA = path.join(root, "scratch-a");
const scratchB = path.join(root, "scratch-b");
const policyFile = path.join(root, "policy.json");
const policy = {
  generation: 1,
  kill_switch: false,
  full_access: { mode: "window", max_minutes: 30, max_concurrent: 2 },
  tunnel_ids: ["tunnel_fixture"],
  workspace_roots: [workspace],
  protected_paths: [],
  scratch_roots: [],
};
await fs.mkdir(workspace);
await fs.writeFile(policyFile, JSON.stringify(policy));

const text = result => result.content?.filter(part => part.type === "text").map(part => part.text).join("\n") || "";
const pendingState = async taskId => {
  const result = await client.callTool({ name: "pending_approvals", arguments: { task_id: taskId } });
  return result.structuredContent;
};
const windowFiles = async () =>
  (await fs.readdir(path.join(tasks, "approval", "windows")).catch(() => []))
    .filter(name => name.endsWith(".json"));
const taskExists = async taskId =>
  fs.access(path.join(tasks, taskId + ".json")).then(() => true, () => false);

function connect(scratchRoot) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href, "index.mjs"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      THRIFTYRELAY_TASK_DIR: tasks,
      THRIFTYRELAY_TEMP_WORKSPACE: scratchRoot,
      THRIFTYRELAY_TEST_POLICY_FILE: policyFile,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", chunk => process.stderr.write(chunk));
  return { transport, client: new Client({ name: "approval-decline-test", version: "1" }, { capabilities: {} }) };
}

let connection = connect(scratchA);
let client = connection.client;
await client.connect(connection.transport);

try {
  // A write held for approval: the card shows the planned path and can fetch the body, but the
  // record must not already contain a second copy of it.
  const first = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "write", path: "note.txt", content: "pending-body" }],
  } });
  const firstText = text(first);
  assert.match(firstText, /APPROVAL_REQUIRED/, firstText);
  const firstId = first.structuredContent?.task_id;
  assert.match(firstId, /^task_/, firstText);

  const shown = await pendingState(firstId);
  assert.equal(shown.state, "pending");
  assert.equal(shown.item.scratch, true);
  assert.equal(shown.item.stale, false);
  const step = shown.item.steps[0];
  assert.equal(step.kind, "write");
  assert.equal(step.targets[0].value, path.join(scratchA, firstId, "note.txt"));
  assert.equal(step.targets[0].planned, true);
  assert.equal(step.body_bytes, Buffer.byteLength("pending-body"));

  const detail = await client.callTool({ name: "approval_step", arguments: { task_id: firstId, index: 0 } });
  assert.equal(detail.structuredContent.body, "pending-body");
  assert.equal(detail.structuredContent.truncated, false);

  const card = await client.callTool({ name: "open_approval", arguments: { task_id: firstId } });
  assert.equal(card.structuredContent?.approval_required, true);
  assert.equal(card.structuredContent?.task_id, firstId);

  const declined = await client.callTool({ name: "decline_task", arguments: { task_id: firstId } });
  assert.equal(declined.structuredContent?.declined, true);
  assert.match(text(declined), /declined/);
  assert.equal((await pendingState(firstId)).state, "declined");

  // The declined request must not leave a task, a scratch directory, or a spent window.
  const inspected = await client.callTool({ name: "remote_inspect", arguments: { task_id: firstId, wait_ms: 0 } });
  assert.match(text(inspected), /APPROVAL_DECLINED/, text(inspected));
  assert.doesNotMatch(text(inspected), /Task not found/, text(inspected));
  const reopened = await client.callTool({ name: "open_approval", arguments: { task_id: firstId } });
  assert.equal(reopened.isError, true);
  assert.match(text(reopened), /APPROVAL_DECLINED/);
  assert.equal(await taskExists(firstId), false);
  await fs.access(path.join(scratchA, firstId)).then(
    () => assert.fail("a declined request created its scratch directory"),
    () => {});
  assert.deepEqual(await windowFiles(), []);

  // A leftover claim cannot hide a saved decline, and a stale card cannot approve it again.
  const firstClaimed = path.join(tasks, "approval", "pending", firstId + ".claimed.json");
  await fs.writeFile(firstClaimed, JSON.stringify({ task_id: firstId, args: { steps: [] } }));
  assert.match(text(await client.callTool({ name: "remote_inspect", arguments: { task_id: firstId, wait_ms: 0 } })),
    /APPROVAL_DECLINED/);
  assert.match(text(await client.callTool({ name: "approve_task", arguments: { task_id: firstId, minutes: 5 } })),
    /APPROVAL_DECLINED/);
  await fs.rm(firstClaimed);

  // Expiry is checked on approval itself, without refreshing a list first. Racing that
  // approval with the card's expiry cleanup must never open a window or create a task.
  const late = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "write", path: "late.txt", content: "never" }],
  } });
  const lateId = late.structuredContent.task_id;
  const lateFile = path.join(tasks, "approval", "pending", lateId + ".json");
  const lateRecord = JSON.parse(await fs.readFile(lateFile, "utf8"));
  assert.equal(Object.hasOwn(lateRecord, "steps"), false);
  lateRecord.created_at = new Date(Date.now() - 11 * 60_000).toISOString();
  await fs.writeFile(lateFile, JSON.stringify(lateRecord));
  const lateResults = await Promise.all([
    client.callTool({ name: "approve_task", arguments: { task_id: lateId, minutes: 5 } }),
    client.callTool({ name: "open_approval", arguments: { task_id: lateId } }),
  ]);
  assert(lateResults.every(result => result.isError === true));
  assert.match(text(await client.callTool({ name: "remote_inspect", arguments: { task_id: lateId, wait_ms: 0 } })),
    /APPROVAL_EXPIRED/);
  assert.equal(await taskExists(lateId), false);
  assert.deepEqual(await windowFiles(), []);

  // A conflicting pending/claimed pair is not a new approval opportunity.
  const conflict = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "write", path: "conflict.txt", content: "never" }],
  } });
  const conflictId = conflict.structuredContent.task_id;
  const conflictPending = path.join(tasks, "approval", "pending", conflictId + ".json");
  const conflictClaimed = path.join(tasks, "approval", "pending", conflictId + ".claimed.json");
  await fs.copyFile(conflictPending, conflictClaimed);
  assert.match(text(await client.callTool({ name: "approve_task", arguments: { task_id: conflictId, minutes: 5 } })),
    /APPROVAL_STATE_CONFLICT/);
  assert.equal(await taskExists(conflictId), false);
  await fs.rm(conflictPending);
  assert.match(text(await client.callTool({ name: "remote_inspect", arguments: { task_id: conflictId, wait_ms: 0 } })),
    /APPROVAL_IN_PROGRESS/);
  await fs.rm(conflictClaimed);

  const blocked = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "write", path: "blocked.txt", content: "never" }],
  } });
  const blockedId = blocked.structuredContent.task_id;
  const blockedDecision = path.join(tasks, "approval", "decisions", blockedId + ".json.new");
  await fs.mkdir(blockedDecision);
  assert.match(text(await client.callTool({ name: "decline_task", arguments: { task_id: blockedId } })),
    /APPROVAL_CLOSE_FAILED/);
  assert.match(text(await client.callTool({ name: "remote_inspect", arguments: { task_id: blockedId, wait_ms: 0 } })),
    /APPROVAL_IN_PROGRESS/);
  assert.match(text(await client.callTool({ name: "approve_task", arguments: { task_id: blockedId, minutes: 5 } })),
    /APPROVAL_IN_PROGRESS/);
  assert.equal(await taskExists(blockedId), false);
  await fs.rmdir(blockedDecision);

  // Multibyte text is capped in bytes without splitting a character. Short multiline
  // commands retain their exact body even though their summary is compressed for the list.
  const preview = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [
      { kind: "write", path: "unicode.txt", content: "日本語🙂".repeat(3000) },
      { kind: "run", command: "echo one\necho two" },
      { kind: "patch", files: [{ path: "a.txt", edits: [{ old_string: "a", new_string: "b" }] }] },
    ],
  } });
  const previewId = preview.structuredContent.task_id;
  const previewState = await pendingState(previewId);
  assert.equal(previewState.item.steps[2].stats.edits, 1);
  assert.equal(previewState.item.steps[2].targets[0].value, path.join(scratchA, previewId, "a.txt"));
  const unicode = await client.callTool({ name: "approval_step", arguments: { task_id: previewId, index: 0 } });
  assert.equal(unicode.structuredContent.truncated, true);
  assert.equal(unicode.structuredContent.total_chars, 12000);
  assert.equal(unicode.structuredContent.total_bytes, 39000);
  assert(Buffer.byteLength(unicode.structuredContent.body) <= 8192);
  assert(!unicode.structuredContent.body.endsWith("\uFFFD"));
  const command = await client.callTool({ name: "approval_step", arguments: { task_id: previewId, index: 1 } });
  assert.equal(command.structuredContent.body, "echo one\necho two");
  await client.callTool({ name: "decline_task", arguments: { task_id: previewId } });

  // Approval still runs: one window, one task, and an id that now resolves as started.
  // Windows PowerShell 5.1 can spend over 30 seconds starting on hosted runners.
  const second = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "run", command: "echo approved-run",
      ...(process.platform === "win32" ? { shell: "pwsh.exe" } : {}) }],
  } });
  const secondId = second.structuredContent?.task_id;
  assert.match(text(second), /APPROVAL_REQUIRED/, text(second));
  const approved = await client.callTool({ name: "approve_task", arguments: { task_id: secondId, minutes: 5 } });
  assert.match(text(approved), /approved and started/, text(approved));
  const result = await client.callTool({ name: "remote_inspect", arguments: { task_id: secondId, wait_ms: 30000 } });
  assert.match(text(result), /succeeded/, text(result));
  assert.equal((await pendingState(secondId)).state, "started");
  assert.equal((await windowFiles()).length, 1);
  // Approval and decline share one claim. Whichever wins, only that decision takes effect.
  const raced = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "write", path: "race.txt", content: "once" }],
  } });
  const racedId = raced.structuredContent.task_id;
  const choices = await Promise.all([
    client.callTool({ name: "approve_task", arguments: { task_id: racedId, minutes: 5 } }),
    client.callTool({ name: "decline_task", arguments: { task_id: racedId } }),
  ]);
  assert.equal(choices.filter(result => !result.isError).length, 1);
  const didRun = choices.some(result => result.structuredContent?.approved === true);
  await client.callTool({ name: "remote_inspect", arguments: { task_id: racedId } });
  assert.equal(await taskExists(racedId), didRun);
  assert.equal((await windowFiles()).length, didRun ? 2 : 1);

  // A third submission is left pending across a restart. The second process is planned against
  // a different scratch root; approving the old plan must close it, not move the write.
  const third = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "write", path: "note.txt", content: "stale" }],
  } });
  const thirdId = third.structuredContent?.task_id;
  assert.match(text(third), /APPROVAL_REQUIRED/, text(third));
  await client.close();

  connection = connect(scratchB);
  client = connection.client;
  await client.connect(connection.transport);
  const invalidated = await client.callTool({ name: "approve_task", arguments: { task_id: thirdId, minutes: 5 } });
  assert.equal(invalidated.isError, true);
  assert.match(text(invalidated), /APPROVAL_INVALIDATED/, text(invalidated));
  assert.equal((await pendingState(thirdId)).state, "invalidated");
  assert.equal(await taskExists(thirdId), false);
  assert.equal((await windowFiles()).length, didRun ? 2 : 1);
  // A failure before a task record exists must not claim the task started or discard the
  // unresolved claim. The spent window must not be spent again by a retry of the old card.
  await fs.writeFile(scratchB, "not a directory");
  const unavailable = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "write", path: "unavailable.txt", content: "never" }],
  } });
  const unavailableId = unavailable.structuredContent.task_id;
  const notStarted = await client.callTool({ name: "approve_task", arguments: { task_id: unavailableId, minutes: 5 } });
  assert.match(text(notStarted), /TASK_START_FAILED: SCRATCH_UNAVAILABLE/);
  assert.equal(notStarted.structuredContent?.approved, undefined);
  assert.equal(await taskExists(unavailableId), false);
  assert.equal((await pendingState(unavailableId)).state, "claimed");
  const consumed = (await windowFiles()).length;
  assert.match(text(await client.callTool({ name: "approve_task", arguments: { task_id: unavailableId, minutes: 5 } })),
    /APPROVAL_IN_PROGRESS/);
  assert.equal((await windowFiles()).length, consumed);
  console.log("APPROVAL DECLINE: declined without a window; approve still runs; changed scratch root is invalidated");
} finally {
  await client.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
