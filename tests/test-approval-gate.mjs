import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The gate answers before a task exists, so a submission that can never run must not reach the
// approval card. A card would spend a window, and the strict check would then fail at start
// before the task record is written, leaving the caller with "Task not found" instead of the
// reason. This drives a registered policy without scratch roots, which is where an escape path
// used to be classified as an ordinary write outside every root.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-approval-gate-"));
const tasks = path.join(root, "tasks");
const policy = {
  generation: 1,
  kill_switch: false,
  full_access: { mode: "window", max_minutes: 30, max_concurrent: 2 },
  tunnel_ids: ["tunnel_fixture"],
  workspace_roots: [path.join(root, "workspace")],
  protected_paths: [],
  scratch_roots: [],
};
await fs.mkdir(path.join(root, "workspace"));
await fs.writeFile(path.join(root, "policy.json"), JSON.stringify(policy));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href, "index.mjs"],
  cwd: process.cwd(),
  env: { ...process.env, THRIFTYRELAY_TASK_DIR: tasks,
    THRIFTYRELAY_TEST_POLICY_FILE: path.join(root, "policy.json") },
  stderr: "pipe",
});
transport.stderr?.on("data", chunk => process.stderr.write(chunk));
const client = new Client({ name: "approval-gate-test", version: "1" }, { capabilities: {} });
const text = result => result.content?.filter(part => part.type === "text").map(part => part.text).join("\n") || "";
const pendingCount = async () =>
  (await fs.readdir(path.join(tasks, "approval", "pending")).catch(() => [])).length;

await client.connect(transport);
try {
  const health = text(await client.callTool({ name: "health", arguments: {} }));
  assert.match(health, /enforcement=policy:standard:window-closed/, health);

  const escapes = [
    ["parent", ["..", "escape.txt"].join(path.sep)],
    ["token", "{{scratch}}" + path.sep + ".." + path.sep + "escape.txt"],
  ];
  for (const [name, target] of escapes) {
    const result = await client.callTool({ name: "remote_task", arguments: {
      scratch: true, steps: [{ kind: "write", path: target, content: "x" }],
    } });
    const body = text(result);
    assert.equal(result.isError, true, name + " was not refused: " + body);
    assert.match(body, /^SCRATCH_PATH_ESCAPE: /, name + " returned a different error: " + body);
    assert.doesNotMatch(body, /APPROVAL_REQUIRED/, name + " was held for approval: " + body);
  }
  assert.equal(await pendingCount(), 0, "an escape left a pending approval");

  // The same submission with a path inside the task directory is a normal write outside every
  // registered root, so it must still be offered as a card rather than refused by the gate.
  const legit = await client.callTool({ name: "remote_task", arguments: {
    scratch: true, steps: [{ kind: "write", path: "note.txt", content: "x" }],
  } });
  const legitText = text(legit);
  assert.match(legitText, /APPROVAL_REQUIRED/, legitText);
  assert.equal(legit.structuredContent?.approval_required, true, legitText);
  assert.equal(await pendingCount(), 1);
  console.log("APPROVAL GATE: escape refused before approval; in-task write still offered");
} finally {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
