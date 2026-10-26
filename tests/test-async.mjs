import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { testTaskWaiting } from "./test-task-wait.mjs";
import { VERSION } from "../src/version.mjs";

await testTaskWaiting();

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-async-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["--import", pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href, "index.mjs"],
  cwd: process.cwd(),
  env: { ...process.env, THRIFTYRELAY_TASK_DIR: tmp,
    THRIFTYRELAY_TEST_POLICY_FILE: path.join(tmp, "missing-policy.json") }, stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const client = new Client({ name: "async-integration-test", version: "1" }, { capabilities: {} });
const txt = (r) => r.content?.[0]?.text || "";
const call = async (name, args) => await client.callTool({ name, arguments: args });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(id, status, limit = 30000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const info = txt(await call("remote_inspect", { task_id: id }));
    if (info.includes("| " + status + " |")) return info;
    if (/\| (failed|timed_out|cancelled|interrupted)/.test(info) && !info.includes("| " + status + " |")) {
      throw new Error("Unexpected state: " + info);
    }
    await sleep(350);
  }
  throw new Error("Task did not reach " + status + ": " + txt(await call("remote_inspect", { task_id: id })));
}
async function start(args, maxMs = 3500) {
  const t = Date.now();
  const r = await call("remote_task", { execution: "async", ...args });
  const ms = Date.now() - t;
  const id = txt(r).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0];
  if (r.isError || !id || ms > maxMs) throw new Error("Async did not respond promptly: " + ms + "ms " + txt(r));
  console.log("ASYNC START:", id, ms + "ms");
  return id;
}
await client.connect(transport);
try {
  const definitions = (await client.listTools()).tools;
  const tools = definitions.map((t) => t.name);
  if (tools.join(",") !== "health,remote_task,open_approval,pending_approvals,approve_task,decline_task,approval_step,remote_inspect,open_settings,settings_update") throw new Error("Unexpected tool list " + tools);
  const waitSchema = definitions.find(tool => tool.name === "remote_inspect").inputSchema.properties.wait_ms;
  assert.equal(waitSchema.default, 120000);
  assert.equal(waitSchema.minimum, 0);
  assert.equal(waitSchema.maximum, 120000);
  for (const wait_ms of [-1, 120001, 0.5]) {
    assert((await call("remote_inspect", { task_id: "task_invalid_abcdef", wait_ms })).isError);
  }
  const health = txt(await call("health", {}));
  if (!health.includes(`ThriftyRelay ${VERSION}:`)) throw new Error("Wrong version " + health);

  // This suite covers the task mechanism. The shell layer starts Windows PowerShell 5.1 with
  // its profile and without -NoProfile, which costs about 20 seconds per start on a cold
  // runner and pushes a two-step task past the client's 60 second request timeout. The
  // standard suite uses pwsh.exe, and the run path in the server is the same for both.
  const id = await start({ steps: [
    { kind: "run", command: "Write-Output 'ASYNC_ONE'; Start-Sleep -Seconds 4; Write-Output 'ASYNC_FINISHED'", shell: "pwsh.exe", timeout_ms: 30000 },
    { kind: "run", command: "Write-Output 'SECOND_STEP'", shell: "pwsh.exe", timeout_ms: 30000 },
  ] });
  // The step is accepted before its shell exists, so a snapshot taken immediately can still
  // report the step as pending. Poll briefly instead of racing the worker.
  const runningDeadline = Date.now() + 5000;
  let snapshot = await call("remote_inspect", { task_id: id, wait_ms: 0, step_index: 0 });
  while (Date.now() < runningDeadline && !txt(snapshot).includes("| running |")) {
    await sleep(50);
    snapshot = await call("remote_inspect", { task_id: id, wait_ms: 0, step_index: 0 });
  }
  assert(!snapshot.isError && txt(snapshot).includes("| running |"), "first step not reported running: " + txt(snapshot));
  const request = new AbortController();
  const interruptedWait = client.callTool({ name: "remote_inspect", arguments: { task_id: id } }, undefined,
    { signal: request.signal });
  const rejectedWait = assert.rejects(interruptedWait);
  await sleep(80);
  request.abort();
  await rejectedWait;
  const result = txt(await call("remote_inspect", { task_id: id }));
  assert(result.includes("| succeeded |"), "one blocking inspect must receive completion after an interrupted wait: " + result);
  if (!result.includes("2/2 steps finished")) throw new Error("Missing progress: " + result);
  const step = txt(await call("remote_inspect", { task_id: id, step_index: 0 }));
  if (!step.includes("ASYNC_FINISHED")) throw new Error("Step output missing: " + step);
  console.log("ASYNC SUCCESS:", result.split("\n")[0]);

  const cancel = await start({ steps: [
    { kind: "run", command: "Write-Output 'CANCEL_TEST'; Start-Sleep -Seconds 25; Write-Output 'SHOULD_NOT_FINISH'", shell: "pwsh.exe", timeout_ms: 50000 }
  ] });
  await sleep(1500);
  const cancelResult = txt(await call("remote_inspect", { task_id: cancel, action: "cancel" }));
  if (!cancelResult.includes("cancellation requested")) throw new Error("Cancel response: " + cancelResult);
  const cancelInfo = await until(cancel, "cancelled", 30000);
  console.log("ASYNC CANCEL:", cancelInfo.split("\n")[0]);

  const timeout = await start({ task_timeout_ms: 1700, steps: [
    { kind: "run", command: "Write-Output 'TIMEOUT_TEST'; Start-Sleep -Seconds 25; Write-Output 'SHOULD_NOT_FINISH'", shell: "pwsh.exe", timeout_ms: 50000 }
  ] });
  const timeoutInfo = await until(timeout, "timed_out", 30000);
  console.log("ASYNC TIMEOUT:", timeoutInfo.split("\n")[0]);

  const completedCancel = txt(await call("remote_inspect", { task_id: id, action: "cancel" }));
  if (!completedCancel.includes("already finished")) throw new Error("Finished task cancel was not rejected");

  const initialTimeout = await call("remote_task", {
    execution: "sync", task_timeout_ms: 20000,
    steps: [{ kind: "run", command: "Write-Output 'INITIAL_TIMEOUT_OUTPUT'; Start-Sleep -Seconds 15",
      shell: "pwsh.exe", timeout_ms: 8000, expose: true }],
  });
  const initialTimeoutText = txt(initialTimeout);
  if (!initialTimeout.isError || !initialTimeoutText.includes("timed_out") ||
      (initialTimeoutText.match(/INITIAL_TIMEOUT_OUTPUT/g) || []).length !== 1) {
    throw new Error("Initial output lost or duplicated on timeout: " + initialTimeoutText);
  }
  const initialTimeoutId = initialTimeoutText.match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0];
  const savedTimeout = txt(await call("remote_inspect", { task_id: initialTimeoutId, step_index: 0 }));
  if ((savedTimeout.match(/INITIAL_TIMEOUT_OUTPUT/g) || []).length !== 1) {
    throw new Error("Initial timeout output was not persisted once: " + savedTimeout);
  }
  console.log("INITIAL TIMEOUT OUTPUT retained once in response and stored result");
  console.log("ASYNC TESTS PASSED");
} finally {
  await client.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
