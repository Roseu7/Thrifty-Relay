import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverSkills } from "../src/skills/catalog.mjs";
import { extractImages, imageBlocks, storeImages, loadImages, storedImageRefs, removeImages } from "../src/mcp/image-content.mjs";

await import("./test-commander-output.mjs");

// `echo` and `exit 7` behave the same in PowerShell and in a POSIX shell, so only the
// shell itself differs: naming PowerShell makes it run the command and exit, while the
// Windows default shell keeps the session open and never reports completion. POSIX
// systems run their default shell correctly, so they need no override.
const RUN_SHELL = process.platform === "win32" ? { shell: "pwsh.exe" } : {};

const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-tests-"));
const imagePath = path.join(import.meta.dirname, "..", "assets", "tr.png");
const imageData = (await fs.readFile(imagePath)).toString("base64");
const imageResult = { content: [{ type: "image", data: imageData, mimeType: "image/png" }] };
const extracted = extractImages(imageResult);
assert.equal(extracted.images.length, 1);
assert.equal(extracted.bytes, Buffer.from(imageData, "base64").length);
assert.deepEqual(imageBlocks(extracted.images), imageResult.content);
assert.equal(extractImages({ content: [{ ...imageResult.content[0], mimeType: "IMAGE/PNG; charset=binary" }] }).images[0].mimeType, "image/png");
assert.deepEqual(extractImages({ content: [{ ...imageResult.content[0], mimeType: "image/svg+xml" }] }).omitted, ["unsupported-mime"]);
for (const data of ["!!!!", "a===", "abc", "AA=A", "AB==", "AAB=", ""]) {
  assert.deepEqual(extractImages({ content: [{ ...imageResult.content[0], data }] }).omitted, ["invalid-base64"]);
}
assert.deepEqual(extractImages(imageResult, { images: 0, bytes: extracted.bytes }).omitted, ["limit"]);
assert.deepEqual(extractImages(imageResult, { images: 1, bytes: extracted.bytes - 1 }).omitted, ["limit"]);
const imageTaskId = "image-unit";
try {
  const stored = await storeImages(taskDir, imageTaskId, 0, extracted.images);
  assert.equal(stored.failed, 0);
  assert.equal(stored.refs.length, 1);
  assert.deepEqual(storedImageRefs({ content: stored.refs }), stored.refs);
  assert.deepEqual(await loadImages(taskDir, imageTaskId, stored.refs), { images: imageResult.content, unavailable: 0 });
  const outside = path.join(taskDir, "images", "outside.png");
  await fs.writeFile(outside, Buffer.from(imageData, "base64"));
  assert.deepEqual(await loadImages(taskDir, imageTaskId, [
    { ...stored.refs[0], attachment: "../outside.png" },
    { ...stored.refs[0], attachment: "..\\outside.png" },
    { ...stored.refs[0], bytes: stored.refs[0].bytes + 1 },
  ]), { images: [], unavailable: 3 });
  await fs.unlink(outside);
} finally {
  await removeImages(taskDir, imageTaskId);
}
console.log("IMAGE UNITS OK");

// Use an owned fixture instead of assuming developers have a named global Skill.
const fixtureHome = path.join(taskDir, "fixture-codex-home");
const fixtureDir = path.join(fixtureHome, "skills", "CI Example");
const fixtureSkill = path.join(fixtureDir, "SKILL.md");
await fs.mkdir(fixtureDir, { recursive: true });
await fs.writeFile(fixtureSkill, "---\nname: CI Example\ndescription: Fixture for portable MCP Skills discovery\n---\nCI_FIXTURE_SKILL_OK\n");
const discovered = await discoverSkills(fixtureHome);
if (discovered.length !== 1 || discovered[0].name !== "CI Example" ||
    discovered[0].file !== path.join("CI Example", "SKILL.md")) {
  throw new Error("Skills discovery fixture failed");
}
const transport = new StdioClientTransport({
  command: "node",
  args: ["--import", pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href, "index.mjs"],
  cwd: process.cwd(),
  env: { ...process.env, THRIFTYRELAY_TASK_DIR: taskDir,
    THRIFTYRELAY_TEST_POLICY_FILE: path.join(taskDir, "missing-policy.json") },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

const client = new Client(
  { name: "wrapper-test", version: "0.1.0" },
  { capabilities: {} },
);
try {
console.time("connect");
await client.connect(transport);
console.timeEnd("connect");
const instructions = client.getInstructions();
if (client.getServerVersion()?.name !== "ThriftyRelay") {
  throw new Error("MCP initialization server name changed");
}
if (!instructions?.includes("ThriftyRelay Skills discovery") ||
    !instructions.includes("SKILL.md")) {
  throw new Error("MCP initialize is missing the Skills catalog");
}

const tools = await client.listTools();
const toolNames = tools.tools.map((tool) => tool.name);
if (toolNames.length !== 10 || !["health", "remote_task", "remote_inspect", "open_settings", "settings_update", "open_approval", "pending_approvals", "approve_task", "decline_task", "approval_step"].every((name) => toolNames.includes(name))) {
  throw new Error("Public MCP tool count or names changed");
}
console.log("TOOLS", toolNames.join(","));
console.log("SKILLS INIT", instructions.length, "chars");
const oversizedInput = await client.callTool({
  name: "health", arguments: { nested: { values: Array(10_000).fill(0) } },
});
assert.equal(oversizedInput.isError, true);
assert.match(oversizedInput.content?.[0]?.text ?? "", /maximum of 10000 elements/);
const healthResult = await client.callTool({ name: "health", arguments: {} });
if (healthResult.isError || !healthResult.content?.[0]?.text?.startsWith("ThriftyRelay ")) {
  throw new Error("Health branding changed");
}

const imageArgs = {
  steps: [{ kind: "read", path: imagePath, expose: true }],
  max_exposed_chars: 1000,
};
function assertImage(result) {
  assert.ok(!result.isError, result.content?.[0]?.text);
  assert.ok(result.content.some(block => block.type === "text"));
  assert.deepEqual(result.content.filter(block => block.type === "image"), imageResult.content);
}
function imageTask(result) {
  const id = result.content?.[0]?.text?.match(/Task (task_[a-z0-9]+_[a-z0-9]{6})/)?.[1];
  assert.ok(id, result.content?.[0]?.text);
  return id;
}
const syncImage = await client.callTool({ name: "remote_task", arguments: imageArgs });
assertImage(syncImage);
const syncImageId = imageTask(syncImage);
const storedImageJson = await fs.readFile(path.join(taskDir, syncImageId + ".json"), "utf8");
assert.ok(storedImageJson.includes('"attachment"'));
assert.ok(!storedImageJson.includes(imageData));
assertImage(await client.callTool({ name: "remote_inspect", arguments: {
  task_id: syncImageId, step_index: 0, max_chars: 500,
} }));
const asyncImage = await client.callTool({ name: "remote_task", arguments: { ...imageArgs, execution: "async" } });
const asyncImageId = imageTask(asyncImage);
assertImage(await client.callTool({ name: "remote_inspect", arguments: { task_id: asyncImageId } }));
console.log("IMAGE MCP sync=OK step_index=OK async=OK");

console.time("remote_task");
const result = await client.callTool({
  name: "remote_task",
  arguments: {
    steps: [
      {
        kind: "read",
        path: path.join(import.meta.dirname, "..", "package.json"),
        length: 20,
        expose: true,
        label: "package",
      },
      {
        kind: "run",
        command: "echo wrapper-run-ok",
        ...RUN_SHELL,
        timeout_ms: 10000,
        expose: false,
        label: "run",
      },
    ],
  },
});
console.timeEnd("remote_task");
console.log("RESULT");
console.log(result.content?.[0]?.text ?? JSON.stringify(result));
const skillRead = await client.callTool({ name: "remote_task", arguments: {
  steps: [{ kind: "read", path: fixtureSkill, length: 8, expose: true }],
} });
if (skillRead.isError || !skillRead.content?.[0]?.text?.includes("CI_FIXTURE_SKILL_OK")) {
  throw new Error("On-demand SKILL.md read failed");
}
console.log("SKILLS READ OK");
const health = await client.callTool({ name: "health", arguments: {} });
if (!health.content?.[0]?.text?.includes("OK")) throw new Error("health did not return OK");

const invalid = await client.callTool({ name: "remote_inspect", arguments: { task_id: "../config" } });
if (!invalid.isError) throw new Error("invalid task ID was accepted");

const failure = await client.callTool({ name: "remote_task", arguments: {
  steps: [{ kind: "run", command: "exit 7", ...RUN_SHELL, timeout_ms: 10000 }],
} });
if (!failure.isError || !failure.content?.[0]?.text?.includes("FAIL(exit 7)")) {
  throw new Error("non-zero exit was not reported as failure");
}
const search = await client.callTool({ name: "remote_task", arguments: {
  steps: [{ kind: "search", path: taskDir,
    pattern: "task_", search_type: "files", max_results: 3, timeout_ms: 12000, expose: false }],
} });
if (search.isError) throw new Error("search failed: " + search.content?.[0]?.text);
console.log("EXTRA CHECKS health=OK invalid-id=REJECTED nonzero=FAILED search=OK");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-test-"));
try {
  const a = path.join(tmp, "a.txt");
  const b = path.join(tmp, "b.txt");
  await fs.writeFile(a, "alpha\r\nbeta\r\n", "utf8");
  await fs.writeFile(b, "red\nblue\n", "utf8");

  const success = await client.callTool({ name: "remote_task", arguments: {
    steps: [{ kind: "patch", files: [
      { path: a, edits: [{ old_string: "alpha", new_string: "ALPHA" }] },
      { path: b, edits: [{ old_string: "blue", new_string: "BLUE" }] },
    ] }],
  } });
  if (success.isError || await fs.readFile(a, "utf8") !== "ALPHA\r\nbeta\r\n" ||
      await fs.readFile(b, "utf8") !== "red\nBLUE\n") {
    throw new Error("patch success check failed: " + success.content?.[0]?.text);
  }

  const failure = await client.callTool({ name: "remote_task", arguments: {
    steps: [{ kind: "patch", files: [
      { path: a, edits: [{ old_string: "ALPHA", new_string: "BROKEN" }] },
      { path: b, edits: [{ old_string: "not-present", new_string: "BROKEN" }] },
    ] }],
  } });
  if (!failure.isError || await fs.readFile(a, "utf8") !== "ALPHA\r\nbeta\r\n") {
    throw new Error("patch mismatch did not fail atomically");
  }

  const missingEdit = await client.callTool({ name: "remote_task", arguments: {
    steps: [{ kind: "edit", file_path: a, old_string: "MISSING_EDIT_MARKER", new_string: "NO" }],
  } });
  if (!missingEdit.isError || !missingEdit.content?.[0]?.text.includes("edit_block: ERROR")) {
    throw new Error("edit_block mismatch must be reported as failure");
  }

  const once = await client.callTool({ name: "remote_task", arguments: {
    steps: [{ kind: "run", command: "echo RUN_ONCE_6427", ...RUN_SHELL, timeout_ms: 10000, expose: true }],
  } });
  const occurrences = (once.content?.[0]?.text.match(/RUN_ONCE_6427/g) ?? []).length;
  if (once.isError || occurrences !== 1) {
    throw new Error("run output was duplicated or lost: " + once.content?.[0]?.text);
  }
  console.log("NEW CHECKS patch=OK mismatch=REJECTED run_output_once=OK");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

} finally {
  await client.close();
  await fs.rm(taskDir, { recursive: true, force: true });
}
process.exit(0);
