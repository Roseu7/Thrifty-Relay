import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { probeProcesses } from "../src/mcp/execution-guard.mjs";
import { probeProcessCommand } from "../src/platform/posix/process.mjs";
import { startForegroundRuntime } from "../src/runtime/foreground.mjs";

// Windows uses the existing task path. This file exercises the detached process group
// that POSIX foreground starts, including the SIGTERM exit code and group cleanup.
if (process.platform !== "win32") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thrifty-runtime-posix-"));
  const tunnelScript = [
    "#!/bin/sh",
    "url_file=''",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = '--health.url-file' ]; then url_file=\"$2\"; shift 2; else shift; fi",
    "done",
    "printf 'http://127.0.0.1:49123\\n' > \"$url_file\"",
    "while :; do sleep 1; done",
  ].join("\n");
  const writeTunnel = async name => {
    const file = path.join(root, name);
    await fs.writeFile(file, tunnelScript, { mode: 0o755 });
    await fs.chmod(file, 0o755);
    return file;
  };
  let child = null;
  let unverifiedChild = null;
  try {
    const tunnel = await writeTunnel("fake tunnel-client");
    const packageRoot = root;
    await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "scripts", "sanitized-mcp.mjs"), "");

    let output = "";
    const processRef = new EventEmitter();
    processRef.stdout = { write(chunk) { output += String(chunk); return true; } };
    processRef.stderr = { write(chunk) { output += String(chunk); return true; } };

    const runtime = await startForegroundRuntime({
      config: {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        tunnelClientPath: tunnel,
        packageRoot,
      },
      env: { PATH: process.env.PATH },
      platform: process.platform,
      credentialStore: { get: async () => ({ state: "registered", secret: "fixture-runtime-secret" }) },
      processRef,
      tempRoot: root,
      healthPort: 0,
      startupTimeoutMs: 5000,
      pollIntervalMs: 10,
      stopGraceMs: 2000,
      stopKillWaitMs: 2000,
      spawnImpl: (command, args, options) => {
        child = spawn(command, args, options);
        return child;
      },
      processProbe: async ids => {
        const rows = await probeProcesses(ids, true);
        return rows.map(row => row.pid === child.pid ? { ...row, executable: tunnel } : row);
      },
      portOwnerProbe: async () => child?.pid ? [child.pid] : [],
      fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
    });

    assert.equal(runtime.pid, child.pid);
    assert.equal(runtime.pgid, child.pid, "the tunnel must lead its own process group");
    assert(Number.isFinite(Date.parse(runtime.startedAt)), "the runtime must return its start identity");
    assert.equal(output.includes("fixture-runtime-secret"), false);
    const commandInfo = await probeProcessCommand(child.pid);
    assert(commandInfo && commandInfo.uid === process.geteuid(), "the command probe must report the effective UID");
    assert(commandInfo.argv?.includes(tunnel) || commandInfo.command?.includes(tunnel),
      "the argv probe must see the configured script path");

    const running = runtime.waitForExit();
    processRef.emit("SIGTERM");
    const result = await running;
    assert.deepEqual(result, { exitCode: 143, code: "RUNTIME_STOPPED" });
    assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" },
      "the whole process group must be gone after SIGTERM");

    const unverifiedTunnel = await writeTunnel("fake tunnel-unverified");
    const unverifiedRef = new EventEmitter();
    unverifiedRef.stdout = { write() { return true; } };
    unverifiedRef.stderr = { write() { return true; } };
    await assert.rejects(startForegroundRuntime({
      config: {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        tunnelClientPath: unverifiedTunnel,
        packageRoot,
      },
      env: { PATH: process.env.PATH },
      platform: process.platform,
      credentialStore: { get: async () => ({ state: "registered", secret: "fixture-runtime-secret" }) },
      processRef: unverifiedRef,
      tempRoot: root,
      healthPort: 0,
      startupTimeoutMs: 5000,
      pollIntervalMs: 10,
      stopGraceMs: 2000,
      stopKillWaitMs: 2000,
      spawnImpl: (command, args, options) => {
        unverifiedChild = spawn(command, args, options);
        return unverifiedChild;
      },
      processProbe: async ids => {
        const rows = await probeProcesses(ids, true);
        return rows.map(row => row.pid === unverifiedChild.pid ? { ...row, executable: unverifiedTunnel } : row);
      },
      portOwnerProbe: async () => [],
      fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
    }), { code: "RUNTIME_OWNER_UNVERIFIED" });
    assert.throws(() => process.kill(-unverifiedChild.pid, 0), { code: "ESRCH" },
      "an unverified owner must stop the process group");
    console.log("POSIX RUNTIME CHECKS OK (detached group, health/PID ownership, SIGTERM 143, unverified owner, group cleanup)");
  } finally {
    for (const processTree of [child, unverifiedChild]) {
      if (processTree?.pid) {
        try { process.kill(-processTree.pid, "SIGKILL"); } catch {}
      }
    }
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
