import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const base=path.join(process.env.THRIFTYRELAY_TEST_ROOT,"live"), cwd=path.join(base,"workspace"), dir=path.join(base,"tasks");
await fs.mkdir(cwd,{recursive:true}); await fs.mkdir(dir,{recursive:true});
const stateFile=path.join(base,"live-state.json");let state;
try{state=JSON.parse((await fs.readFile(stateFile,"utf8")).replace(/^\uFEFF/,""));}
catch(error){if(error.code!=="ENOENT")throw error;state={marker:"RELAY_"+randomUUID().slice(0,8),luna_request_id:randomUUID(),sol_request_id:randomUUID()};await fs.writeFile(stateFile,JSON.stringify(state));}
await fs.writeFile(path.join(cwd,"AGENTS.md"),"Only work in this dedicated validation directory. Do not read secrets, use MCP/network/browser/PC tools, delegate, change auth or configuration, or leave background processes. Do not edit AGENTS.md or verify.mjs. Use the shell only for scoped Node assertions.\n");
await fs.writeFile(path.join(cwd,"verify.mjs"),"import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum(2,3),5); assert.equal(sum(-2,3),1); console.log('CHECK_OK');\n");
const evidence={live:true,root:base,turns:[],checks:[],planned_inference_turns:2,passed:false};
const text=result=>result.content?.filter(item=>item.type==="text").map(item=>item.text).join("\n")||"";
const idOf=result=>{assert(!result.isError,text(result));const id=text(result).match(/task_[a-z0-9]+_[a-z0-9]{6}/)?.[0];assert(id);return id;};
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(import.meta.dirname, "..", "index.mjs")],cwd: path.resolve(import.meta.dirname, ".."),
  env:{...process.env,THRIFTYRELAY_CODEX_WORKSPACE:cwd,THRIFTYRELAY_TASK_DIR:dir},stderr:"pipe"});
transport.stderr?.resume();const client=new Client({name:"thriftyrelay-local-live",version:"1"},{capabilities:{}});
async function runtimeMetadata(threadId) {
  const sessions=path.join(process.env.CODEX_HOME||path.join(os.homedir(),".codex"),"sessions");
  for(const delta of [0,-1,1]) {
    const date=new Date(Date.now()+delta*86400000), stamp=date.toISOString().slice(0,10).split("-");
    const folder=path.join(sessions,...stamp);let names;
    try{names=await fs.readdir(folder);}catch(error){if(error.code==="ENOENT")continue;throw error;}
    const name=names.find(value=>value.endsWith(threadId+".jsonl"));if(!name)continue;
    const file=path.join(folder,name);if((await fs.stat(file)).size>2*1024*1024)throw new Error("Owned session exceeds bounded verification read");
    const rows=(await fs.readFile(file,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    const context=rows.filter(row=>row.type==="turn_context").at(-1)?.payload;
    const provider=rows.find(row=>row.type==="session_meta")?.payload.model_provider;
    return {model:context?.model,effort:context?.effort,sandbox:context?.sandbox_policy?.type,provider};
  }
  throw new Error("Owned session metadata not found in bounded date directories");
}
async function run(step, checkExclusion=false) {
  const args={execution:"async",task_timeout_ms:300000,steps:[step]},started=Date.now();
  const id=idOf(await client.callTool({name:"remote_task",arguments:args}));
  assert.equal(idOf(await client.callTool({name:"remote_task",arguments:args})),id);
  let exclusionChecked=false,status;
  const deadline=Date.now()+320000;
  while(Date.now()<deadline) {
    status=text(await client.callTool({name:"remote_inspect",arguments:{task_id:id}}));
    if(/\| (succeeded|failed|cancelled|timed_out)/.test(status))break;
    if(checkExclusion&&!exclusionChecked) {
      const locked=await fs.stat(path.join(dir,"codex","active.lock")).then(()=>true,()=>false);
      if(locked) {
        const canary=path.join(cwd,"must-not-exist.txt");
        const denied=await client.callTool({name:"remote_task",arguments:{steps:[{kind:"write",path:canary,content:"unexpected"}]}});
        assert(denied.isError&&text(denied).includes("REMOTE_EXECUTION_LOCKED"));
        assert.equal(await fs.stat(canary).then(()=>true,()=>false),false);
        const read=await client.callTool({name:"remote_task",arguments:{steps:[{kind:"read",path:path.join(cwd,"AGENTS.md"),length:1}]}});
        assert(!read.isError);exclusionChecked=true;
      }
    }
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  const output=JSON.parse(text(await client.callTool({name:"remote_inspect",arguments:{task_id:id,step_index:0}})));
  const turn={task_id:id,requested_model:step.model,status,elapsed_ms:Date.now()-started,error:output.error}; evidence.turns.push(turn);
  if(!status?.includes("| succeeded |"))throw new Error("Live turn failed: "+JSON.stringify(turn));
  const conversation=JSON.parse(await fs.readFile(path.join(dir,"codex",output.conversation_id+".json")));
  const runtime=await runtimeMetadata(conversation.thread_id);
  Object.assign(turn,{conversation_id:output.conversation_id,thread_id:conversation.thread_id,runtime,usage:output.usage,review:output.review});
  assert.equal(runtime.model,step.model);assert.equal(runtime.effort,step.model==="gpt-6-luna"?"max":"high");
  assert.equal(runtime.provider,"openai");assert.equal(runtime.sandbox,"danger-full-access");
  assert.equal(idOf(await client.callTool({name:"remote_task",arguments:args})),id);
  if(checkExclusion)assert(exclusionChecked,"Live turn finished before exclusion could be measured");
  console.log("LIVE "+JSON.stringify(turn));return output;
}
try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools;evidence.tool_names=tools.map(item=>item.name);
  evidence.tools_bytes=Buffer.byteLength(JSON.stringify(tools));
  assert.deepEqual(evidence.tool_names,["health","remote_task","open_approval","pending_approvals","approve_task","decline_task","approval_step","remote_inspect","open_settings","settings_update"]);
  const marker=state.marker;
  let luna;
  if(state.luna_task_id){
    const saved=JSON.parse(await fs.readFile(path.join(dir,state.luna_task_id+".json")));
    assert.equal(saved.status,"succeeded");luna=JSON.parse(text(saved.steps[0].result));
    assert.equal(state.luna_turn.runtime.model,"gpt-6-luna");assert.equal(state.luna_turn.runtime.effort,"max");
    evidence.turns.push(state.luna_turn);evidence.resumed_saved_luna_without_inference=true;
  }else{
    luna=await run({kind:"codex",cwd,permissions:"full-access",task_type:"code",model:"gpt-6-luna",reasoning_effort:"max",expected_files:["sum.mjs"],request_id:state.luna_request_id,
      prompt:`Create only sum.mjs exporting function sum(a,b) returning a+b. Run node verify.mjs and report the actual result. Remember marker ${marker} for a later turn and include it in your short final answer. Do not change or create other files.`},true);
    state.luna_task_id=evidence.turns[0].task_id;state.luna_turn=evidence.turns[0];await fs.writeFile(stateFile,JSON.stringify(state));
  }
  assert(luna.answer.replace(/\p{Cf}/gu,"").includes(marker));assert.equal(luna.review.summary.complete,true);assert.equal(luna.review.summary.unexpected_count,0);
  assert(luna.review.summary.changed.includes("sum.mjs"));
  const report=JSON.parse(await fs.readFile(luna.review.path));
  assert(report.commands.some(item=>item.exit_code===0&&item.output.includes("CHECK_OK")));
  const actualFile=await client.callTool({name:"remote_task",arguments:{steps:[{kind:"read",path:path.join(cwd,"sum.mjs"),expose:true}]}});
  assert(!actualFile.isError&&text(actualFile).includes("sum"));
  const verified=await client.callTool({name:"remote_task",arguments:{steps:[{kind:"run",command:`node '${path.join(cwd,"verify.mjs")}'`,shell:"pwsh.exe",timeout_ms:15000,expose:true}]}});
  assert(!verified.isError&&text(verified).includes("CHECK_OK"));
  evidence.checks.push("live_luna_file_and_assertion","independent_remote_read_and_run_review","duplicate_no_new_execution","live_writer_exclusion_and_concurrent_read");
  const sol=await run({kind:"codex",cwd,permissions:"full-access",task_type:"code",model:"gpt-6.1-sol",reasoning_effort:"high",expected_files:[],request_id:state.sol_request_id,conversation_id:luna.conversation_id,
    prompt:"Explicit Sol High integration test, not an automatic escalation: review the sum.mjs created in the previous turn. Run node verify.mjs, state the remembered RELAY marker from the previous turn, and report any issue. Make no file changes. The caller already independently read the actual file and ran its assertions successfully. Keep the response short."});
  assert(sol.answer.replace(/\p{Cf}/gu,"").includes(marker));assert.equal(sol.conversation_id,luna.conversation_id);
  assert.equal(sol.review.summary.changed_count,0);assert.equal(sol.review.summary.unexpected_count,0);
  assert(JSON.parse(await fs.readFile(sol.review.path)).commands.some(item=>item.exit_code===0&&item.output.includes("CHECK_OK")));
  assert.equal((await fs.readdir(path.join(dir,"codex","requests"))).length,2);
  assert.equal(await fs.stat(path.join(dir,"codex","active.lock")).then(()=>true,()=>false),false);
  evidence.checks.push("live_sol_high_actual_review","cross_model_conversation_continuation","exactly_two_request_claims","no_remaining_lock");
  evidence.passed=true;
}catch(error){evidence.error=String(error.message).slice(0,1200);process.exitCode=1;}
finally{
  await client.close(); await fs.writeFile(process.env.THRIFTYRELAY_TEST_EVIDENCE,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}
