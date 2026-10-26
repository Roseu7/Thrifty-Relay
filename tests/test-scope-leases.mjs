import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScopedLeaseRegistry } from "../src/mcp/scope-leases.mjs";
import { createExecutionGuard } from "../src/mcp/execution-guard.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "thrifty-scope-"));
const cwd = path.join(root, "workspace");
const dir = path.join(root, "tasks");
await fs.mkdir(path.join(cwd, "src", "a"), { recursive: true });
await fs.mkdir(path.join(cwd, "src", "ab"), { recursive: true });
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(cwd, "src", "a", "one.mjs"), "a");
await fs.writeFile(path.join(cwd, "src", "ab", "two.mjs"), "b");

const configFile = path.join(root, "settings.json");
await fs.writeFile(configFile, JSON.stringify({ maxCodexAgents: 3 }));
const first = createScopedLeaseRegistry({dir, workspace:cwd, configFile});
const second = createScopedLeaseRegistry({dir, workspace:cwd, configFile});
let index = 0;
const owner = {pid: process.pid, started_at: new Date().toISOString()};
const claim = (registry, scopes, overrides={}) => {
  const n=++index;
  return registry.acquire({task_id:"task_"+n, request_id:"request_"+n, conversation_id:"cx_"+n, kind:"codex", owner, scopes, ...overrides});
};
const file = path => [{kind:"file",path}];
const directory = path => [{kind:"directory",path}];
async function rejects(promise,code) {
  await assert.rejects(promise, e => e?.code === code, code);
}
try {
  const before = await first.inspect();
  assert(before.lease_count === 0 || before.status === "uninitialized");
  const [a,b]=await Promise.all([
    claim(first,file("src/a/one.mjs")),
    claim(second,file("src/ab/two.mjs")),
  ]);
  let snapshot=await second.inspect();
  assert.equal(snapshot.lease_count,2,"different session instances share registry");
  assert.equal(snapshot.scope_bridge,true,"a legacy-visible bridge must exist while scoped work runs");
  const activeBridgePath=path.join(dir,"codex","active.lock");
  const bridge=JSON.parse(await fs.readFile(activeBridgePath,"utf8"));
  assert.equal(bridge.type,"scope_bridge");
  await rejects(createExecutionGuard({dir}).acquire({task_id:"old_writer",kind:"remote"}), "REMOTE_EXECUTION_LOCKED");
  await rejects(claim(second,file("src/a/one.mjs")), "REMOTE_SCOPE_CONFLICT");
  await rejects(claim(second,directory("src/a")), "REMOTE_SCOPE_CONFLICT");
  await rejects(claim(second,file("src/ab/two.mjs"), {conversation_id:a.conversation_id}), "REMOTE_SESSION_BUSY");
  const c=await claim(second,file("src/a/three.mjs"));
  await rejects(claim(second,file("src/ab/three.mjs")), "REMOTE_LEASE_LIMIT");
  await first.release(a);
  await second.release(b);
  await first.release(c);
  await assert.rejects(fs.stat(activeBridgePath),{code:"ENOENT"}, "last release clears compatible bridge");

  const adjacent = await claim(first,directory("src/a"));
  const disjoint=await claim(second,file("src/ab/two.mjs"));
  await second.release(disjoint);
  await first.release(adjacent);

  const corrupted = [
    "src/../src/a/one.mjs",
    "../outside",
    "src/a/one.mjs:stream",
    "src/a/*.mjs",
    ".git/config",
    "package.json"
  ];
  for (const name of corrupted) await rejects(claim(first,file(name)), "REMOTE_SCOPE_INVALID");
  const unknownDir=path.join(root,"unknown-tasks");
  await fs.mkdir(unknownDir);
  const unknownRegistry=createScopedLeaseRegistry({dir:unknownDir,workspace:cwd,configFile});
  const blocked=await claim(unknownRegistry,file("src/a/one.mjs"));
  await unknownRegistry.retain(blocked,"EXECUTION_UNKNOWN");
  await rejects(claim(unknownRegistry,file("src/ab/two.mjs")), "REMOTE_GLOBAL_LOCKED");
  await rejects(unknownRegistry.release(blocked), "REMOTE_GLOBAL_LOCKED"); // guided recovery only

  const active=path.join(dir,"codex","active.lock");
  await fs.writeFile(active,"legacy-protection");
  await rejects(claim(first,file("src/a/one.mjs")), "REMOTE_GLOBAL_LOCKED");
  await fs.rm(active);

  const maintenance=path.join(dir,"codex","maintenance.lock");
  await fs.writeFile(maintenance,"maintenance");
  await rejects(claim(first,file("src/a/one.mjs")), "REMOTE_GLOBAL_LOCKED");
  await fs.rm(maintenance);

  const registryFile=path.join(dir,"codex","leases.json");
  await fs.writeFile(registryFile,"{\"version\":999}");
  await rejects(claim(second,file("src/a/one.mjs")), "REMOTE_REGISTRY_UNAVAILABLE");
  const final = await second.inspect();
  assert.equal(final.global_locked,true,"corrupt registry must fail closed");
  console.log("PASS: cross-instance reservations, intersection, session exclusion, limit, unknown, legacy, maintenance, invalid scopes, fail-closed");
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
