import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { probeProcesses } from "../src/mcp/execution-guard.mjs";
import { parseGroupRows, probeProcessCommand, probeProcessGroup, runPs, terminateProcessGroup } from "../src/platform/posix/process.mjs";
import { normalizeExecutablePath, processAdapter, terminateProcessTree } from "../src/platform/index.mjs";
import { bindProbe, parseLsofListeners, parseSsListeners, probeListenerOwners, probeListeningProcessIds } from "../src/runtime/listener.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "thrifty-platform-process-"));
const children = new Set();
const checks = [];

async function until(produce, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await produce();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("PLATFORM_PROCESS_FIXTURE_TIMEOUT: " + JSON.stringify(last));
}

function firstLine(stream) {
  return new Promise(resolve => {
    let text = "";
    stream.on("data", chunk => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end >= 0) resolve(text.slice(0, end));
    });
  });
}

try {
  const self = (await probeProcesses([process.pid])).find(row => row.pid === process.pid);
  assert(self, "probe must report the calling process");
  assert.equal(self.parent_pid, process.ppid, "parent_pid must be the real parent");
  assert(Number.isFinite(Date.parse(self.started_at)), "started_at must be parseable by Date.parse");
  assert.match(self.started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/, "started_at must be ISO 8601 UTC");
  checks.push("live-process-identity");

  const repeat = (await probeProcesses([process.pid])).find(row => row.pid === process.pid);
  assert.equal(repeat.started_at, self.started_at, "identity must be stable across probes");
  checks.push("identity-stable-across-probes");

  // A reaped child supplies an OS-valid absent PID on every platform.
  const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => { exited.once("error", reject); exited.once("close", resolve); });
  assert.deepEqual(await probeProcesses([exited.pid]), [],
    "an unused PID is reported as absent, which callers read as 'stopped'");
  await assert.rejects(probeProcesses([0]), { code: "REMOTE_INVALID_PROCESS_ID" });
  await assert.rejects(probeProcesses([]), { code: "REMOTE_INVALID_PROCESS_ID" });
  checks.push("absent-and-invalid-ids");

  const emptyMiss = async () => {
    throw Object.assign(new Error("ps: no matching process"), { code: 1, stdout: "", stderr: "" });
  };
  assert.equal(await runPs(["-p", "999999"], { execImpl: emptyMiss, allowAbsent: true }), "",
    "a clean ps -p miss is the only absence evidence");
  await assert.rejects(runPs(["-e", "-o", "pid="], { execImpl: emptyMiss }),
    { code: "REMOTE_PROCESS_EVIDENCE_UNAVAILABLE" }, "a failed ps -e is not an empty process table");
  assert.equal(await runPs(["-p", "1,999999"], {
    execImpl: async () => { throw Object.assign(new Error("partial"), { code: 1, stdout: "1 0 ...\n", stderr: "" }); },
    allowAbsent: true,
  }), "1 0 ...\n", "a ps -p listing with some missing PIDs is still usable");
  await assert.rejects(runPs(["-p", "999999"], {
    execImpl: async () => { throw Object.assign(new Error("denied"), { code: 1, stdout: "", stderr: "ps: permission denied" }); },
    allowAbsent: true,
  }), { code: "REMOTE_PROCESS_EVIDENCE_UNAVAILABLE" }, "a diagnostic is not absence");
  await assert.rejects(runPs(["-p", "999999"], {
    execImpl: async () => { throw Object.assign(new Error("timeout"), { killed: true, stdout: "", stderr: "" }); },
    allowAbsent: true,
  }), { code: "REMOTE_PROCESS_EVIDENCE_UNAVAILABLE" }, "a timed-out probe is unknown, not absent");
  checks.push("ps-evidence-three-valued");

  const ssLine = 'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("tunnel-client",pid=6123,fd=3))';
  assert.deepEqual(parseSsListeners("", 8080), { listening: false, owners: [] });
  assert.deepEqual(parseSsListeners(ssLine, 8080), {
    listening: true,
    owners: [{ address: "127.0.0.1", family: "ipv4", port: 8080, pid: 6123 }],
  });
  assert.deepEqual(parseSsListeners(
    'LISTEN 0 4096 [::1]:8080 [::]:* users:(("tunnel-client",pid=6124,fd=3))', 8080).owners,
  [{ address: "::1", family: "ipv6", port: 8080, pid: 6124 }]);
  assert.throws(() => parseSsListeners("LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*", 8080),
    { code: "RUNTIME_OWNER_UNKNOWN" }, "a listener with an invisible owner is unknown");
  assert.deepEqual(parseSsListeners(
    'LISTEN 0 4096 192.168.1.5:8080 0.0.0.0:* users:(("other",pid=9999,fd=3))', 8080),
  { listening: false, owners: [] }, "another interface does not conflict with loopback");
  assert.deepEqual(parseLsofListeners("", 8080), { listening: false, owners: [] });
  assert.deepEqual(parseLsofListeners("p6123\nn127.0.0.1:8080\nn[::1]:8080\n", 8080).owners, [
    { address: "127.0.0.1", family: "ipv4", port: 8080, pid: 6123 },
    { address: "::1", family: "ipv6", port: 8080, pid: 6123 },
  ]);
  assert.deepEqual(parseLsofListeners("p9999\nn192.168.1.5:8080\n", 8080),
    { listening: false, owners: [] }, "lsof rows on another interface are ignored");
  assert.throws(() => parseLsofListeners("n127.0.0.1:8080\n", 8080),
    { code: "RUNTIME_OWNER_UNKNOWN" }, "an address without a pid is unknown");

  const ssCalls = [];
  const linuxOwners = await probeListenerOwners(8080, {
    platform: "linux",
    run: async (executable, args) => { ssCalls.push({ executable, args }); return { stdout: ssLine }; },
  });
  assert.equal(linuxOwners.owners[0].pid, 6123);
  assert.equal(ssCalls[0].executable, "ss");
  assert.deepEqual(ssCalls[0].args, ["-H", "-ltnp", "sport = :8080"]);
  const darwinOwners = await probeListenerOwners(8080, {
    platform: "darwin",
    run: async () => ({ stdout: "p6123\nn127.0.0.1:8080\n" }),
  });
  assert.equal(darwinOwners.owners[0].pid, 6123);
  await assert.rejects(probeListenerOwners(8080, {
    platform: "linux",
    run: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  }), { code: "RUNTIME_DEPENDENCY_MISSING" });
  assert.deepEqual(await probeListeningProcessIds(8080, {
    platform: "darwin",
    run: async () => { throw Object.assign(new Error("no match"), { code: 1, stdout: "", stderr: "" }); },
  }), [], "lsof exit 1 without a diagnostic means no listener");
  await assert.rejects(probeListenerOwners(8080, {
    platform: "darwin",
    run: async () => { throw Object.assign(new Error("partial"), { code: 1, stdout: "p6123\nn127.0.0.1:8080\n", stderr: "" }); },
  }), { code: "RUNTIME_OWNER_UNKNOWN" }, "lsof exit 1 with partial output is unknown, not empty");
  checks.push("listener-owner-parsers");

  const freeServer = net.createServer();
  await new Promise((resolve, reject) => {
    freeServer.once("error", reject);
    freeServer.listen(0, "127.0.0.1", resolve);
  });
  const freePort = freeServer.address().port;
  await new Promise(resolve => freeServer.close(resolve));
  assert.equal(await bindProbe(freePort), true);
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(freePort, "127.0.0.1", resolve);
  });
  try {
    await assert.rejects(bindProbe(freePort), { code: "LOCAL_ENDPOINT_IN_USE" });
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
  checks.push("bind-probe");

  const groupRows = parseGroupRows([
    "4321 1 4321 1000 Mon Oct 19 08:00:00 2026 /opt/tunnel-client",
    "5000 4321 4321 1000 Mon Oct 19 08:00:01 2026 node",
  ].join("\n"));
  assert.deepEqual(groupRows.map(row => [row.pid, row.pgid, row.uid, row.command]), [
    [4321, 4321, 1000, "/opt/tunnel-client"],
    [5000, 4321, 1000, "node"],
  ]);
  assert.equal(groupRows[0].started_at, "2026-10-19T08:00:00.000Z");
  const probedGroup = await probeProcessGroup(4321, {
    execImpl: async () => ({ stdout: groupRows.map(row => [
      row.pid, row.parent_pid, row.pgid, row.uid,
      "Mon", "Oct", "19", "08:00:00", "2026", row.command,
    ].join(" ")).join("\n") }),
    resolve: async row => row.command,
  });
  assert.deepEqual(probedGroup.map(row => row.pid), [4321, 5000]);
  await assert.rejects(probeProcessGroup(0, { execImpl: async () => ({ stdout: "" }) }),
    { code: "REMOTE_INVALID_PROCESS_ID" });
  checks.push("process-group-parser");

  const leader = { pid: 4321, parent_pid: 1, pgid: 4321, started_at: "2026-10-19T08:00:00.000Z", executable: "/opt/tunnel-client", command: "/opt/tunnel-client" };
  const follower = { pid: 5000, parent_pid: 4321, pgid: 4321, started_at: "2026-10-19T08:00:01.000Z", executable: "node", command: "node" };
  let signalCalls = [];
  let groupSequence = [[leader], []];
  const groupProbe = async () => groupSequence.shift() ?? [];
  const groupKill = (target, signal) => {
    if (signal === 0) {
      const remaining = groupSequence[0];
      if (!remaining || remaining.length === 0) {
        throw Object.assign(new Error("no such group"), { code: "ESRCH" });
      }
    }
    signalCalls.push([target, signal]);
  };
  assert.deepEqual(await terminateProcessGroup(4321, {
    expectedStartedAt: leader.started_at, probe: groupProbe, kill: groupKill, graceMs: 0, killWaitMs: 0,
    sleep: async () => {},
  }), { ok: true });
  assert.deepEqual(signalCalls, [[-4321, "SIGTERM"]]);

  signalCalls = [];
  groupSequence = [[leader, follower], [follower], []];
  assert.deepEqual(await terminateProcessGroup(4321, {
    probe: groupProbe, kill: groupKill, graceMs: 0, killWaitMs: 0, sleep: async () => {},
  }), { ok: true });
  assert.deepEqual(signalCalls, [[-4321, "SIGTERM"], [-4321, "SIGKILL"]]);

  signalCalls = [];
  groupSequence = [[leader], [leader, follower], []];
  assert.deepEqual(await terminateProcessGroup(4321, {
    probe: groupProbe, kill: groupKill, graceMs: 0, killWaitMs: 0, sleep: async () => {},
  }), { ok: true });
  assert.deepEqual(signalCalls, [[-4321, "SIGTERM"], [-4321, "SIGKILL"]],
    "a child spawned by the known leader may be killed with the group");

  signalCalls = [];
  groupSequence = [[leader], [{ ...follower, parent_pid: 1 }], []];
  assert.deepEqual(await terminateProcessGroup(4321, {
    probe: groupProbe, kill: groupKill, graceMs: 0, killWaitMs: 0, sleep: async () => {},
  }), { ok: false, code: "RUNTIME_OWNER_MISMATCH" });
  assert.deepEqual(signalCalls, [[-4321, "SIGTERM"]],
    "an unrelated member that appeared after the first probe must not be SIGKILLed");

  signalCalls = [];
  groupSequence = [[follower]];
  assert.deepEqual(await terminateProcessGroup(4321, {
    probe: groupProbe, kill: groupKill,
  }), { ok: false, code: "RUNTIME_OWNER_UNVERIFIED" });
  assert.deepEqual(signalCalls, [], "a leaderless first observation is not proof of ownership");

  signalCalls = [];
  groupSequence = [[follower], []];
  assert.deepEqual(await terminateProcessGroup(4321, {
    probe: groupProbe, kill: groupKill, expectedMembers: [leader, follower],
    graceMs: 0, killWaitMs: 0, sleep: async () => {},
  }), { ok: true });
  assert.deepEqual(signalCalls, [[-4321, "SIGTERM"]],
    "a leaderless group with a prior member snapshot can be stopped");

  signalCalls = [];
  groupSequence = [[{ ...leader, started_at: "2026-10-19T09:00:00.000Z" }]];
  assert.deepEqual(await terminateProcessGroup(4321, {
    expectedStartedAt: leader.started_at, probe: groupProbe, kill: groupKill,
  }), { ok: false, code: "RUNTIME_OWNER_MISMATCH" });
  assert.deepEqual(signalCalls, [], "a reused pgid is rejected before signalling");

  groupSequence = [[leader], [leader], [leader]];
  assert.deepEqual(await terminateProcessGroup(4321, {
    probe: groupProbe, kill: () => {}, graceMs: 0, killWaitMs: 0, sleep: async () => {},
  }), { ok: false, code: "RUNTIME_STOP_UNCONFIRMED" });

  assert.deepEqual(await terminateProcessGroup(4321, {
    probe: async () => { throw new Error("unavailable"); }, kill: () => {},
  }), { ok: false, code: "RUNTIME_OWNER_UNKNOWN" });
  checks.push("process-group-stop");

  // Linux reads /proc instead; this exercises the macOS ps parser on every host
  // where /proc is absent, including the Windows unit-test runner.
  if (process.platform !== "linux") {
    const commandInfo = await probeProcessCommand(7001, {
      execImpl: async (file, args) => {
        assert.equal(file, "ps");
        assert.deepEqual(args, ["-ww", "-o", "uid=,args=", "-p", "7001"]);
        return { stdout: " 1000 /opt/tunnel-client run --health\n", stderr: "" };
      },
    });
    assert.deepEqual(commandInfo, {
      pid: 7001, uid: 1000, argv: null, command: "/opt/tunnel-client run --health",
    });
    checks.push("process-command-macos-parser");
  }

  const fixture = path.join(root, "spawn-grandchild.mjs");
  await fs.writeFile(fixture, [
    "import { spawn } from \"node:child_process\";",
    "const child = spawn(process.execPath, [\"-e\", \"setTimeout(() => {}, 60000)\"], { stdio: \"ignore\" });",
    "process.stdout.write(\"grandchild \" + child.pid + \"\\n\");",
    "setTimeout(() => {}, 60000);",
  ].join("\n"));
  const parent = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(parent);
  const grandchildPid = Number((await firstLine(parent.stdout)).trim().split(" ")[1]);
  assert(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);

  const tree = await until(async () => {
    const rows = await probeProcesses([parent.pid], true);
    return rows.some(row => row.pid === grandchildPid) ? rows : null;
  });
  assert(tree.some(row => row.pid === parent.pid), "the root must be present in its own tree");
  assert.equal(tree.find(row => row.pid === grandchildPid).parent_pid, parent.pid,
    "a descendant must be linked to the process under test by parent_pid");
  checks.push("descendant-enumeration");

  await terminateProcessTree(parent.pid);
  await until(async () => (await probeProcesses([parent.pid], true)).length === 0 || null);
  children.delete(parent);
  assert.deepEqual(await probeProcesses([parent.pid], true), [],
    "termination must clear the whole owned tree");
  checks.push("process-tree-termination");

  if (process.platform === "win32") {
    assert.equal(normalizeExecutablePath("C:\\Windows\\System32\\TASKKILL.EXE"),
      normalizeExecutablePath("c:/windows/system32/taskkill.exe"),
      "Windows volumes compare case-insensitively and ignore separators");
  } else {
    assert.notEqual(normalizeExecutablePath("/usr/bin/Node"), normalizeExecutablePath("/usr/bin/node"),
      "POSIX paths stay case-sensitive");
    assert.equal(normalizeExecutablePath("node"), "node", "a bare command name is not invented into a path");
  }
  checks.push("executable-path-normalisation");

  assert.throws(() => processAdapter("aix"), { code: "REMOTE_PLATFORM_UNSUPPORTED" },
    "an OS without an adapter must fail instead of reporting no processes");
  assert.equal(processAdapter(process.platform), processAdapter(process.platform));
  checks.push("unsupported-platform-fails-loudly");

  console.log("PASS: " + checks.join(", "));
} finally {
  for (const child of children) {
    try { await terminateProcessTree(child.pid); } catch {}
    try { child.kill("SIGKILL"); } catch {}
  }
  try { await fs.rm(root, { recursive: true, force: true }); } catch {}
}
