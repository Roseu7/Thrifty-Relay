import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createCodexAdapter, waitForWorkerProcesses } from "../src/codex/adapter.mjs";
import { createTaskManager } from "../src/mcp/task-manager.mjs";
import { fixtureQuotaReader } from "./quota-fixture.mjs";
import { createScopedLeaseRegistry } from "../src/mcp/scope-leases.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tr-scoped-adapter-"));
const cwd = path.join(root, "workspace");
const dir = path.join(root, "tasks");
const workerFile = path.join(root, "fixture-worker.mjs");
const textOf = result => result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
const taskId = () => "task_" + Date.now().toString(36) + "_" + randomUUID().replaceAll("-", "").slice(0, 6);
const idPattern = /^task_[a-z0-9]+_[a-z0-9]{6}$/;
const taskOf = result => {
  assert.equal(result.isError, undefined, textOf(result));
  const id = textOf(result).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0];
  assert(id, textOf(result));
  return id;
};
const until = async (fn, what, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("TIMEOUT: " + what);
};
let succeeded = false;
try {
  const processRow = { pid: 6123, started_at: "2026-10-25T08:00:00.000Z" };
  let probes = 0, clock = 0;
  assert.equal(await waitForWorkerProcesses([processRow], {
    probe: async () => ++probes < 3 ? [processRow] : [], now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; },
  }), true);
  assert.equal(probes, 3, "process presence after close is rechecked before retaining the lease");
  assert.equal(await waitForWorkerProcesses([processRow, { pid: 6123, observed_absent_at: processRow.started_at }], {
    probe: async () => [{ ...processRow, started_at: "2026-10-25T08:00:01.000Z" }],
    sleep: async () => assert.fail("PID reuse must not wait for an unrelated process"),
  }), true);
  clock = 0;
  assert.equal(await waitForWorkerProcesses([processRow], {
    probe: async () => [processRow], now: () => clock, timeoutMs: 250,
    sleep: async milliseconds => { clock += milliseconds; },
  }), false, "a surviving process must still retain the lease after the grace period");
  assert.equal(clock, 250);
  await assert.rejects(waitForWorkerProcesses([processRow], {
    probe: async () => { throw Object.assign(new Error(), { code: "REMOTE_PROCESS_EVIDENCE_UNAVAILABLE" }); },
  }), { code: "REMOTE_PROCESS_EVIDENCE_UNAVAILABLE" });
  await assert.rejects(waitForWorkerProcesses([{ pid: 6123 }]), { code: "CODEX_PROCESS_EVIDENCE_UNKNOWN" });
  await assert.rejects(waitForWorkerProcesses([processRow], { probe: async () => [{ pid: 6123 }] }),
    { code: "CODEX_PROCESS_EVIDENCE_UNKNOWN" });
  console.log("PASS: bounded worker exit checks preserve unknown/surviving processes and distinguish PID reuse");

  await fs.mkdir(dir);
  for (const letter of ["a", "b", "c"]) await fs.mkdir(path.join(cwd, "src", letter), { recursive: true });
  const home = path.join(root, "auth");
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", tokens: { access_token: "test-only-not-a-real-token" }
  }));
  process.env.CODEX_HOME = home;
  process.env.THRIFTYRELAY_CODEX_WORKSPACE = cwd;
  // No production credentials or real inference are used by this fixture worker.
  // The workers stay running until the test creates the release file: the checks below need
  // both leases held, and a fixed delay ran out first on a slow CI runner.
  const releaseFile = path.join(root, "release-workers");
  await fs.writeFile(workerFile, [
    'import fs from "node:fs/promises";',
    'import path from "node:path";',
    'process.on("message", async ({cwd,prompt,thread_id}) => {',
    '  if (!/^[abc]$/.test(prompt)) process.exit(4);',
    '  process.send({type:"thread",id:thread_id || "12345678-1234-1234-1234-123456789abc"});',
    '  await fs.writeFile(path.join(cwd,"src",prompt,"result.txt"),prompt);',
    `  const release = ${JSON.stringify(releaseFile)};`,
    '  while (!(await fs.access(release).then(() => true, () => false))) await new Promise(resolve => setTimeout(resolve, 50));',
    '  process.send({type:"result",completed:true,answer:"FIXTURE_"+prompt}, () => process.exit(0));',
    '});',
  ].join("\n"));
  const adapter = createCodexAdapter({ dir, taskId, workerFile, quotaReader: fixtureQuotaReader,
    configFile: path.join(dir, "fixture-config.json") });
  const manager = createTaskManager({ dir, taskId, idPattern, textOf,
    compactText: String, truncate: (s, n) => s.slice(0, n), redactHistory: String,
    executeStep: (step, context) => adapter.execute(step, context) });
  const registry = createScopedLeaseRegistry({dir, workspace:cwd});
  const args = (prompt, scope, extra = {}) => ({
    execution:"async", task_timeout_ms:30000, steps:[{
      kind:"codex", cwd, permissions:"full-access", request_id:randomUUID(), task_type:"code",
      model:"gpt-6-luna", reasoning_effort:"medium", prompt,
      ...(scope === undefined ? {} : {write_scopes:[{kind:"file",path:"src/"+scope+"/result.txt"}]}),
      ...extra
    }]
  });
  const submit = value => adapter.submit(value, manager.run);
  const done = id => until(async () => {
    const task = JSON.parse(await fs.readFile(path.join(dir, id+".json"),"utf8"));
    return task.finished_at ? task : null;
  }, "task " + id, 30000);

  const [startA, startB] = await Promise.all([submit(args("a","a")),submit(args("b","b"))]);
  const idA=taskOf(startA), idB=taskOf(startB);
  assert.notEqual(idA,idB);
  const both = await until(async()=>{
    const snapshot = await registry.inspect();
    return snapshot.lease_count===2 && snapshot.status==="active" ? snapshot : null;
  }, "two concurrent scoped leases");
  assert.equal(both.scope_bridge,true);
  assert.equal(both.unknown_count,0);
  console.log("PASS: two disjoint Codex workers admitted concurrently");

  const conflictId=taskOf(await submit(args("a","a")));
  const conflict=await done(conflictId);
  assert.equal(conflict.status,"failed");
  assert.match(textOf(conflict.steps[0].result),/CODEX_SCOPE_CONFLICT/);
  assert.equal((await registry.inspect()).lease_count,2);
  console.log("PASS: overlapping write scope rejected before worker execution");

  const session=both.leases.find(row=>row.task_id===idA)?.conversation_id;
  assert(session);
  await until(async()=>{
    const record=JSON.parse(await fs.readFile(path.join(dir,"codex",session+".json"),"utf8").catch(()=>"{}"));
    return record.thread_id && record.state==="running";
  },"running conversation metadata");
  const sameSessionId=taskOf(await submit(args("c","c",{conversation_id:session})));
  const sameSession=await done(sameSessionId);
  assert.equal(sameSession.status,"failed");
  assert.match(textOf(sameSession.steps[0].result),/CODEX_(?:SESSION_BUSY|CONVERSATION_INTERRUPTED_INSPECT_FIRST)/);
  assert.equal((await registry.inspect()).lease_count,2);
  console.log("PASS: same conversation cannot run concurrently across scopes");

  const legacyId=taskOf(await submit(args("c",undefined)));
  const legacy=await done(legacyId);
  assert.equal(legacy.status,"failed");
  assert.match(textOf(legacy.steps[0].result),/CODEX_EXECUTION_LOCKED/);
  assert.equal((await registry.inspect()).lease_count,2);
  console.log("PASS: legacy global writer excluded by scoped bridge");

  await fs.writeFile(releaseFile, "");
  const [finishedA,finishedB]=await Promise.all([done(idA),done(idB)]);
  assert.equal(finishedA.status,"succeeded",JSON.stringify(finishedA.steps));
  assert.equal(finishedB.status,"succeeded",JSON.stringify(finishedB.steps));
  assert.equal(await fs.readFile(path.join(cwd,"src","a","result.txt"),"utf8"),"a");
  assert.equal(await fs.readFile(path.join(cwd,"src","b","result.txt"),"utf8"),"b");
  const ending=await registry.inspect();
  assert.equal(ending.lease_count,0);
  assert.equal(ending.scope_bridge,false);
  console.log("PASS: concurrent workers succeeded; all scoped leases/bridge released");

  // The actual public MCP schema is independently checked without real model execution.
  const transport=new StdioClientTransport({command:process.execPath,
    args:["--import",pathToFileURL(path.join(import.meta.dirname,"policy-isolation.mjs")).href,path.resolve(import.meta.dirname,"..","index.mjs")],
    cwd:path.resolve(import.meta.dirname,".."),env:{...process.env,THRIFTYRELAY_TASK_DIR:path.join(root,"protocol-tasks"),
      THRIFTYRELAY_TEST_POLICY_FILE:path.join(root,"missing-policy.json"),
      THRIFTYRELAY_CODEX_WORKSPACE:cwd},stderr:"pipe"});
  transport.stderr?.resume();
  const client=new Client({name:"scope-schema-test",version:"1"},{capabilities:{}});
  try {
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    const codex=tools.find(tool=>tool.name==="remote_task")?.inputSchema?.properties?.steps;
    assert(codex,"remote_task schema missing");
    assert(JSON.stringify(codex).includes("write_scopes"),"write_scopes missing from MCP schema");
    console.log("PASS: new remote_task MCP schema exposes write_scopes");
  } finally {await client.close();}
  succeeded=true;
  console.log("PASS: scoped adapter integration tests (no network inference)");
} finally {
  if(succeeded) await fs.rm(root,{recursive:true,force:true});
  else console.error("Fixture retained for inspection:",root);
}
