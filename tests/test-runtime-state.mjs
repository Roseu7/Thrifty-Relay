import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stopBackgroundRuntime } from "../src/runtime/background.mjs";
import {
  MAX_STATE_BYTES,
  ensureRuntimeDirectory,
  readRuntimeState,
  runtimeDirectory,
  runtimeStateFile,
  validateRuntimeState,
  writeRuntimeState,
} from "../src/runtime/state.mjs";

const checks = [];

function fixture(overrides = {}) {
  return {
    version: 1,
    instanceId: randomUUID(),
    state: "starting",
    mode: "background",
    port: 8080,
    healthUrl: "http://127.0.0.1:8080",
    logFile: "/home/rose/.local/state/thriftyrelay/runtime.log",
    createdAt: "2026-10-19T08:00:00.000Z",
    supervisorPid: null,
    supervisorUid: null,
    supervisorStartedAt: null,
    supervisorExecutable: null,
    supervisorCommand: null,
    tunnelPid: null,
    tunnelUid: null,
    tunnelStartedAt: null,
    tunnelExecutable: null,
    tunnelCommand: null,
    tunnelPgid: null,
    ownerVerified: false,
    cleanup: null,
    errorCode: null,
    ...overrides,
  };
}

assert.equal(runtimeDirectory({ platform: "linux", env: {}, home: "/home/rose" }),
  "/home/rose/.local/state/thriftyrelay");
assert.equal(runtimeDirectory({ platform: "linux", env: { XDG_STATE_HOME: "/state" }, home: "/home/rose" }),
  "/state/thriftyrelay");
assert.equal(runtimeDirectory({ platform: "linux", env: { XDG_STATE_HOME: "relative" }, home: "/home/rose" }),
  "/home/rose/.local/state/thriftyrelay");
assert.equal(runtimeDirectory({ platform: "darwin", env: {}, home: "/Users/rose" }),
  "/Users/rose/Library/Application Support/ThriftyRelay");
assert.equal(runtimeStateFile({ platform: "linux", env: {}, home: "/home/rose" }),
  "/home/rose/.local/state/thriftyrelay/runtime.json");
assert.throws(() => runtimeDirectory({ platform: "win32", env: {}, home: "C:\\Users\\rose" }),
  { code: "REMOTE_PLATFORM_UNSUPPORTED" });
checks.push("state-path-conventions");

const valid = fixture();
assert.equal(validateRuntimeState(valid).instanceId, valid.instanceId);
assert.equal(validateRuntimeState(fixture({
  state: "running", ownerVerified: true, tunnelPid: 6123, tunnelUid: 1000,
  tunnelStartedAt: "2026-10-19T08:00:01.000Z", tunnelExecutable: "/opt/tunnel-client",
  tunnelPgid: 6123,
})).state, "running");
for (const [name, value] of [
  ["version", fixture({ version: 2 })],
  ["state", fixture({ state: "adopted" })],
  ["mode", fixture({ mode: "manual" })],
  ["port", fixture({ port: 0 })],
  ["health-url", fixture({ healthUrl: "http://127.0.0.1:8081" })],
  ["created-at", fixture({ createdAt: "not-a-date" })],
  ["pid", fixture({ supervisorPid: -1 })],
  ["executable", fixture({ supervisorExecutable: "relative/path" })],
  ["cleanup", fixture({ cleanup: "pending" })],
  ["error-code", fixture({ errorCode: "bad code" })],
  ["array", []],
  ["missing-field", (() => { const value = fixture(); delete value.ownerVerified; return value; })()],
  ["running-without-owner", fixture({ state: "running", ownerVerified: false, tunnelPid: 6123 })],
]) {
  assert.throws(() => validateRuntimeState(value), { code: "RUNTIME_STATE_INVALID" }, name);
}
checks.push("state-schema");

if (process.platform !== "win32") {
  const root = await fs.mkdtemp(path.join(os.homedir(), ".thriftyrelay-state-"));
  try {
    const directory = path.join(root, "runtime");
    await ensureRuntimeDirectory(directory);
    assert.equal((await fs.stat(directory)).mode & 0o7777, 0o700);
    const file = path.join(directory, "runtime.json");
    assert.deepEqual(await writeRuntimeState(file, valid), valid);
    assert.deepEqual(await readRuntimeState(file), valid);
    assert.equal((await fs.stat(file)).mode & 0o7777, 0o600);
    assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith(".tmp")), []);
    assert.equal(await readRuntimeState(path.join(directory, "missing.json")), null);
    checks.push("state-round-trip");

    await fs.writeFile(file, '{"version":2}\n', { mode: 0o600 });
    await assert.rejects(readRuntimeState(file), { code: "RUNTIME_STATE_INVALID" });
    await writeRuntimeState(file, valid);

    await fs.chmod(file, 0o644);
    await assert.rejects(readRuntimeState(file), { code: "RUNTIME_STATE_INSECURE" });
    await fs.chmod(file, 0o600);

    const link = path.join(directory, "link.json");
    await fs.symlink(file, link);
    await assert.rejects(readRuntimeState(link), { code: "RUNTIME_STATE_INSECURE" });
    await fs.unlink(link);

    const hard = path.join(root, "hard.json");
    await fs.link(file, hard);
    await assert.rejects(readRuntimeState(file), { code: "RUNTIME_STATE_INSECURE" });
    await fs.unlink(hard);

    await fs.writeFile(file, "x".repeat(MAX_STATE_BYTES + 1), { mode: 0o600 });
    await assert.rejects(readRuntimeState(file), { code: "RUNTIME_STATE_INSECURE" });
    checks.push("state-rejects-unsafe-files");

    const loose = path.join(root, "loose");
    await fs.mkdir(loose, { mode: 0o700 });
    await fs.chmod(loose, 0o777);
    await assert.rejects(ensureRuntimeDirectory(loose), { code: "RUNTIME_STATE_INSECURE" });
    checks.push("state-rejects-unsafe-directory");

    const realDirectory = path.join(root, "real-state");
    const linkDirectory = path.join(root, "state-link");
    await ensureRuntimeDirectory(realDirectory);
    await fs.symlink(realDirectory, linkDirectory);
    const linkedFile = path.join(linkDirectory, "runtime.json");
    await writeRuntimeState(linkedFile, valid);
    assert.deepEqual(await readRuntimeState(linkedFile), valid);
    checks.push("state-follows-trusted-symlink-directory");

    // A terminal record can reach disk before the supervisor process finishes exiting.
    const stopDirectory = path.join(root, "stop-state");
    await ensureRuntimeDirectory(stopDirectory);
    const stopFile = path.join(stopDirectory, "runtime.json");
    const stopRecord = fixture({ state: "stopped", cleanup: "complete", supervisorPid: 6123,
      supervisorStartedAt: "2026-10-19T08:00:01.000Z", logFile: path.join(stopDirectory, "runtime.log") });
    const aliveRow = { pid: 6123, started_at: stopRecord.supervisorStartedAt };
    for (const state of ["stopped", "failed"]) {
      await writeRuntimeState(stopFile, { ...stopRecord, state });
      let alive = true, waits = 0;
      const signals = [];
      assert.deepEqual(await stopBackgroundRuntime({ stateFile: stopFile,
        processProbe: async () => alive ? [aliveRow] : [],
        probeGroup: async () => [], bindPort: async () => true,
        kill: (pid, signal) => signals.push([pid, signal]),
        sleepImpl: async () => { waits++; alive = false; },
      }), { ok: true, stopped: true });
      assert.equal(waits, 1, "a terminal record must still wait for the supervisor to exit");
      assert.deepEqual(signals, [[6123, "SIGTERM"]]);
      assert.equal(await readRuntimeState(stopFile), null);
    }
    for (const processProbe of [async () => [aliveRow], async () => { throw new Error("probe failed"); }]) {
      await writeRuntimeState(stopFile, stopRecord);
      await assert.rejects(stopBackgroundRuntime({ stateFile: stopFile, processProbe,
        probeGroup: async () => [], bindPort: async () => true, kill: () => {}, timeoutMs: 0,
      }), { code: "RUNTIME_STOP_UNCONFIRMED" });
      assert.equal((await readRuntimeState(stopFile)).instanceId, stopRecord.instanceId);
    }
    const replacement = { ...stopRecord, instanceId: randomUUID(), supervisorPid: 6124 };
    await writeRuntimeState(stopFile, stopRecord);
    assert.deepEqual(await stopBackgroundRuntime({ stateFile: stopFile,
      processProbe: async () => [aliveRow], probeGroup: async () => [], bindPort: async () => true,
      kill: pid => assert.equal(pid, 6123),
      sleepImpl: async () => writeRuntimeState(stopFile, replacement),
    }), { ok: true, stopped: true, record: "replaced" });
    assert.equal((await readRuntimeState(stopFile)).instanceId, replacement.instanceId);
    checks.push("stop-waits-for-exit-and-preserves-unconfirmed-or-replaced-state");
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
} else {
  checks.push("state-file-checks-skipped-on-windows");
}

console.log("PASS: " + checks.join(", "));
