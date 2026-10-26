import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScopedLeaseRegistry } from "../src/mcp/scope-leases.mjs";
import { inspectScopedRecovery, recoverScopedLease } from "../src/mcp/recovery.mjs";
import { probeProcesses } from "../src/mcp/execution-guard.mjs";

const roots=[];
const codeIs = code => err => { if(err?.code!==code) console.error("wanted",code,"actual",err?.code);return err?.code===code; };
async function fixture(tag,{liveOwner=false,retain=true}={}) {
 // The fixture root is resolved because the registry and the records the code under test
 // writes use the real path: macOS reports os.tmpdir() as /var/... while its realpath is
 // /private/var/..., so an unresolved root would make the fixture disagree with the code.
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"tr-independent-"+tag+"-")));roots.push(root);
 const dir=path.join(root,"tasks"), workspace=path.join(root,"workspace"), configFile=path.join(root,"settings.json");
 await fs.mkdir(path.join(workspace,"src"),{recursive:true}); await fs.mkdir(dir); 
 await fs.writeFile(path.join(workspace,"src","a.mjs"),"a");
 await fs.writeFile(path.join(workspace,"src","b.mjs"),"b");
 await fs.writeFile(configFile, JSON.stringify({maxCodexAgents:3}));
 const registry=createScopedLeaseRegistry({dir,workspace,configFile});
 const running=liveOwner ? (await probeProcesses([process.pid])).find(r=>r.pid===process.pid) : null;
 if(liveOwner) assert(running?.started_at,"process start evidence required");
 const owner=liveOwner?{pid:running.pid,started_at:running.started_at}:{pid:9999987,started_at:"2025-01-01T00:00:00.000Z"};
 const task_id="task_"+tag+"_abcdef",request_id="request_"+tag+"_abcdef",conversation_id="cx_"+tag.padEnd(32,"0").slice(0,32).replace(/[^a-f0-9]/g,"f");
 const lease=await registry.acquire({task_id,request_id,conversation_id,kind:"codex",owner,scopes:[{kind:"file",path:"src/a.mjs"}]});
 await fs.mkdir(path.join(dir,"codex","requests"),{recursive:true});
 const {createHash}=await import("node:crypto");
 const h=s=>createHash("sha256").update(s).digest("hex");
 await fs.writeFile(path.join(dir,task_id+".json"),JSON.stringify({id:task_id,codex_request_id:request_id,status:liveOwner?"running":"failed",guard_state:"unknown",...(liveOwner?{}:{finished_at:new Date().toISOString()})}));
 await fs.writeFile(path.join(dir,"codex","requests",h(request_id)+".json"),JSON.stringify({task_id,request_id,conversation_id,state:"unknown"}));
 await fs.writeFile(path.join(dir,"codex",conversation_id+".json"),JSON.stringify({id:conversation_id,version:2,cwd:workspace,state:"running"}));
 if(retain) await registry.retain(lease,"TEST_EXECUTION_UNKNOWN");
 return {root,dir,workspace,configFile,registry,lease,task_id,request_id,conversation_id};
}
async function prepare(f) {
 const snap=await inspectScopedRecovery(f.dir,f.workspace);
 const candidate=snap.candidates.find(c=>c.task_id===f.task_id);
 assert(candidate?.expected,"Expected recoverable lease metadata");
 const expected=candidate.expected;
 const approval={
 task_id:f.task_id,lease_id:f.lease.token,lease_state:candidate.state,
 namespace:expected.namespace,control_sha256:expected.control_sha256,registry_sha256:expected.registry_sha256,bridge_sha256:expected.bridge_sha256,metadata_sha256:expected.metadata_sha256,
 owned_processes_stopped:true,untracked_processes_reviewed:true,files_reviewed:true,external_operations_reviewed:true,
 approved_by:"isolated_test",approval_reference:"independent isolated recovery test",process_evidence:"Isolated fixture process check reviewed",file_evidence:"Only test fixture files were accessed",external_evidence:"No external operations in isolated test"
 };
 return {expected,approval};
}
async function invoke(f,x,confirm=async()=>true) {
 return recoverScopedLease({dir:f.dir,expected:x.expected,task_id:f.task_id,lease_id:f.lease.token,approval:x.approval,confirm,presentReview:async()=>{}});
}
try {
 const success=await fixture("aaa");
 const s=await prepare(success);
 const result=await invoke(success,s);
 assert.equal(result.decision,"released");
 const snapshot=await success.registry.inspect();
 assert.equal(snapshot.lease_count,0);
 assert.equal(snapshot.scope_bridge,false);
 const task=JSON.parse(await fs.readFile(path.join(success.dir,success.task_id+".json"),"utf8"));
 assert.equal(task.status,"interrupted");assert.equal(task.guard_state,"recovered");assert.equal(task.execution_unknown,true);
 const {createHash}=await import("node:crypto");const h=x=>createHash("sha256").update(x).digest("hex");
 const request=JSON.parse(await fs.readFile(path.join(success.dir,"codex","requests",h(success.request_id)+".json"),"utf8"));
 const conversation=JSON.parse(await fs.readFile(path.join(success.dir,"codex",success.conversation_id+".json"),"utf8"));
 assert.equal(request.state,"reviewed_unknown");assert.equal(conversation.state,"interrupted");
 const audits=await fs.readdir(path.join(success.dir,"codex","recovery"));
 assert(audits.some(a=>a.endsWith(".json")),"persisted audit");
 console.log("PASS: scoped recovery releases isolated unknown only after confirmation; audit, task, tombstone, conversation persisted");

 const refusal=await fixture("bbb");const r=await prepare(refusal);
 await assert.rejects(invoke(refusal,r,async()=>false),codeIs("REMOTE_HUMAN_APPROVAL_REQUIRED"));
 assert.equal((await refusal.registry.inspect()).lease_count,1);
 console.log("PASS: approval denial retains unknown lease");

 const tamper=await fixture("ccc");const t=await prepare(tamper);
 await fs.appendFile(path.join(tamper.dir,tamper.task_id+".json")," ");
 await assert.rejects(invoke(tamper,t),codeIs("REMOTE_LOCK_CHANGED"));
 assert.equal((await tamper.registry.inspect()).lease_count,1);
 console.log("PASS: changed task metadata blocks release");

 const other=await fixture("ddd",{retain:false});
 const secondOwner=(await probeProcesses([process.pid])).find(r=>r.pid===process.pid);
 assert(secondOwner?.started_at);
 const owner={pid:secondOwner.pid,started_at:secondOwner.started_at};
 const second=await other.registry.acquire({task_id:"task_ddde_abcdef",request_id:"request_ddde_abcdef",conversation_id:"cx_"+"d".repeat(32),kind:"codex",owner,scopes:[{kind:"file",path:"src/b.mjs"}]});
 await other.registry.retain(other.lease,"TEST_EXECUTION_UNKNOWN");
 const o=await prepare(other);
 await assert.rejects(invoke(other,o),codeIs("REMOTE_SCOPED_OTHER_LEASES_ACTIVE"));
 assert.equal((await other.registry.inspect()).lease_count,2);
 console.log("PASS: concurrent other lease blocks recovery");

 const live=await fixture("eee",{liveOwner:true});const l=await prepare(live);
 await assert.rejects(invoke(live,l),err=>["REMOTE_OWNER_TASK_STILL_ACTIVE","REMOTE_SCOPED_LEASE_OWNER_ACTIVE"].includes(err?.code));
 assert.equal((await live.registry.inspect()).lease_count,1);
 console.log("PASS: currently running owner cannot be force-released");

 console.log("PASS: 5 independent recovery scenarios");
}finally{for(const root of roots)await fs.rm(root,{recursive:true,force:true}).catch(()=>{});}
