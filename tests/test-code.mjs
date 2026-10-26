import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION } from "../src/version.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-code-mode-"));
const isolation = pathToFileURL(path.join(import.meta.dirname, "policy-isolation.mjs")).href;
const transport = new StdioClientTransport({
  command: process.execPath, args: ["--import", isolation, "index.mjs"], cwd: process.cwd(),
  env: { ...process.env, THRIFTYRELAY_TASK_DIR: dir,
    THRIFTYRELAY_TEST_POLICY_FILE: path.join(dir, "missing-policy.json") }, stderr: "pipe",
});
transport.stderr?.on("data", (data) => process.stderr.write(data));
const client = new Client({ name: "code-mode-test", version: "1" }, { capabilities: {} });
const text = (r) => r.content?.filter((x) => x.type === "text").map((x) => x.text).join("\n") || "";
const call = (name, args) => client.callTool({ name, arguments: args });
const run = async (code, extra = {}) =>
  call("remote_task", { steps: [{ kind: "code", code, expose: true }], ...extra });
const assert = (condition, message) => { if (!condition) throw Error(message); };
const check = async (code, expected, shouldFail = false) => {
  const response = await run(code);
  assert(!!response.isError === shouldFail && text(response).includes(expected),
    "Failed check " + expected + ": " + text(response));
  console.log("PASS", expected);
};
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert(names.join(",") === "health,remote_task,open_approval,pending_approvals,approve_task,decline_task,approval_step,remote_inspect,open_settings,settings_update", "Unexpected tools: " + names);
  assert(text(await call("health", {})).includes(`ThriftyRelay ${VERSION}:`), "Wrong version");
  // The shell layer starts Windows PowerShell 5.1 with its profile and without -NoProfile,
  // which costs about 20 seconds per start on a cold runner and would time these fixtures out.
  // The standard suite uses pwsh.exe, and the run path in the server is the same for both.
  await check(
    'const a = await Promise.all([tools.read({path:"package.json",length:20}),tools.run({command:"Write-Output CODEMODE_PASS",shell:"pwsh.exe",timeout_ms:20000})]); if(!a[0].output.includes(' + JSON.stringify(VERSION) + ')||!a[1].output.includes("CODEMODE_PASS")) throw Error("bad result"); text("PARALLEL_OK:" + a.length);',
    "PARALLEL_OK:2",
  );
  await check(
    'let n=0; for(let i=0;i<6;i++) if(i%2===0) n+=i; text("BRANCH_LOOP_"+n);',
    "BRANCH_LOOP_6",
  );
  await check('text("NODE_ACCESS_"+typeof process+"_"+typeof require+"_"+typeof fetch)', "NODE_ACCESS_undefined_undefined_undefined");
  await check('await tools.step({kind:"code",code:"text(1)"});', "Invalid Code Mode operation", true);
  await check('await tools.run({command:"exit 7",shell:"pwsh.exe",timeout_ms:20000});', "SCRIPT_ERROR", true);
  await check('throw new Error("EXPECTED_SCRIPT_ERROR");', "SCRIPT_ERROR", true);
  await check('while(true) {}', "CPU_LIMIT", true);

  const asyncResult = await run('const x=await tools.read({path:"package.json",length:3});text("ASYNC_CODE_OK:"+!!x.output);', { execution: "async" });
  const id = text(asyncResult).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0];
  assert(id, "No async task ID");
  let info = "";
  for (let i = 0; i < 60; i++) {
    info = text(await call("remote_inspect", { task_id: id }));
    if (info.includes("| succeeded |")) break;
    if (/\| (failed|cancelled|timed_out) \|/.test(info)) throw Error(info);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(info.includes("| succeeded |"), "Async Code Mode failed: " + info);
  assert(text(await call("remote_inspect", { task_id: id, step_index: 0 })).includes("ASYNC_CODE_OK:true"), "Missing async output");
  console.log("PASS async integration");

  const cancelling = await run(
    'await tools.run({command:"Write-Output CODE_CANCEL_START; Start-Sleep -Seconds 25",shell:"pwsh.exe",timeout_ms:45000});',
    { execution: "async" },
  );
  const cancelId = text(cancelling).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0];
  assert(cancelId, "No cancellation task ID");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const cancelMessage = text(await call("remote_inspect", { task_id: cancelId, action: "cancel" }));
  assert(cancelMessage.includes("cancellation requested"), "Cancellation not accepted: " + cancelMessage);
  let cancelInfo = "";
  for (let i = 0; i < 60; i++) {
    cancelInfo = text(await call("remote_inspect", { task_id: cancelId }));
    if (cancelInfo.includes("| cancelled |")) break;
    if (/\| (failed|succeeded|timed_out) \|/.test(cancelInfo)) throw Error(cancelInfo);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(cancelInfo.includes("| cancelled |"), "Cancellation incomplete: " + cancelInfo);
  console.log("PASS Code Mode cancellation");
  console.log("CODE MODE TESTS PASSED");
} finally {
  await client.close().catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
}
