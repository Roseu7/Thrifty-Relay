import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startBackgroundRuntime, stopBackgroundRuntime, backgroundStatus } from "../src/runtime/background.mjs";
import { bindProbe } from "../src/runtime/listener.mjs";
import { acquireRuntimeLock } from "../src/runtime/lock.mjs";
import { createRuntimeLog } from "../src/runtime/log.mjs";
import { assertTrustedDirectory } from "../src/runtime/state.mjs";
import { collectDoctorChecks } from "../src/cli/doctor.mjs";

const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";

if (process.platform !== "linux") {
  console.log("SKIP: background integration runs on Linux");
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.homedir(), ".thriftyrelay-bg-test-"));
const stateDirectory = path.join(root, "thriftyrelay");
const configFile = path.join(root, "config.json");
const tunnelFile = path.join(root, "fake-tunnel.mjs");
const repository = path.resolve(import.meta.dirname, "..");
let started = false;

const tunnelSource = `#!/usr/bin/env node
import http from "node:http";
const server = http.createServer((request, response) => {
  if (request.url === "/readyz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  response.writeHead(503);
  response.end("not ready");
});
server.listen(8080, "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

try {
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const firstLock = await acquireRuntimeLock(stateDirectory);
  await assert.rejects(() => acquireRuntimeLock(stateDirectory), error => error.code === "RUNTIME_BUSY");
  await firstLock.release();
  const secondLock = await acquireRuntimeLock(stateDirectory);
  await firstLock.release();
  await assert.rejects(() => acquireRuntimeLock(stateDirectory), error => error.code === "RUNTIME_BUSY");
  await secondLock.release();
  const stale = await acquireRuntimeLock(stateDirectory);
  const old = new Date(Date.now() - 600_000);
  await fs.utimes(path.join(stateDirectory, "runtime.lock"), old, old);
  const reclaimed = await acquireRuntimeLock(stateDirectory);
  await stale.release();
  await reclaimed.release();

  const logFile = path.join(root, "runtime.log");
  const log = await createRuntimeLog(logFile, { maxBytes: 4, assertTrustedDirectory });
  log.stream.write("aa");
  log.stream.write("bbbb");
  await log.end();
  assert.equal(await fs.readFile(path.join(root, "runtime.log.1"), "utf8"), "aa");
  assert.equal(await fs.readFile(logFile, "utf8"), "bbbb");
  await fs.writeFile(tunnelFile, tunnelSource, { mode: 0o700 });
  await fs.chmod(tunnelFile, 0o700);
  await fs.writeFile(configFile, JSON.stringify({
    language: "en",
    mode: "manual",
    tunnelId: TUNNEL_ID,
    tunnelClientPath: tunnelFile,
    workspace: root,
    taskDirectory: path.join(root, "tasks"),
    packageRoot: repository,
  }, null, 2));
  const env = { ...process.env, THRIFTYRELAY_RUNTIME_KEY: "fixture-runtime-key" };

  const dependencyDirectory = path.join(root, "dependency-state");
  await fs.mkdir(dependencyDirectory, { mode: 0o700 });
  await assert.rejects(() => startBackgroundRuntime({
    config: {
      tunnelId: TUNNEL_ID,
      tunnelClientPath: tunnelFile,
      workspace: root,
      taskDirectory: path.join(root, "tasks"),
      packageRoot: repository,
    },
    configFile,
    packageRoot: repository,
    env,
    directory: dependencyDirectory,
    stateFile: path.join(dependencyDirectory, "runtime.json"),
    bindPort: async () => true,
    ownerProbe: async () => { throw Object.assign(new Error("missing"), { code: "RUNTIME_DEPENDENCY_MISSING" }); },
  }), { code: "RUNTIME_DEPENDENCY_MISSING" });
  assert.equal(await fs.stat(path.join(dependencyDirectory, "runtime.json")).then(() => true, () => false), false);

  const invalidDirectory = path.join(root, "invalid-state");
  await fs.mkdir(invalidDirectory, { mode: 0o700 });
  await assert.rejects(() => startBackgroundRuntime({
    config: {
      tunnelId: TUNNEL_ID,
      tunnelClientPath: tunnelFile,
      workspace: root,
      taskDirectory: path.join(root, "tasks"),
      packageRoot: repository,
    },
    configFile,
    packageRoot: "relative-package-root",
    env,
    directory: invalidDirectory,
    stateFile: path.join(invalidDirectory, "runtime.json"),
    bindPort: async () => true,
    ownerProbe: async () => ({}),
  }), { code: "RUNTIME_CONFIG_INVALID" });
  assert.equal(await fs.stat(path.join(invalidDirectory, "runtime.json")).then(() => true, () => false), false);

  const state = await startBackgroundRuntime({
    config: {
      tunnelId: TUNNEL_ID,
      tunnelClientPath: tunnelFile,
      workspace: root,
      taskDirectory: path.join(root, "tasks"),
      packageRoot: repository,
    },
    configFile,
    packageRoot: repository,
    env,
    directory: stateDirectory,
    stateFile: path.join(stateDirectory, "runtime.json"),
    startupTimeoutMs: 20_000,
    pollIntervalMs: 100,
  });
  started = true;
  assert.equal(state.state, "running");
  assert.equal(state.ownerVerified, true);

  const status = await backgroundStatus({ stateFile: path.join(stateDirectory, "runtime.json") });
  assert.equal(status.state, "running");
  assert.equal(status.supervisor, "alive");
  assert.equal(status.listener, "in-use");

  const doctorChecks = await collectDoctorChecks({
    platform: "linux",
    home: root,
    env: {
      ...process.env,
      XDG_STATE_HOME: root,
      THRIFTYRELAY_CONFIG_PATH: configFile,
    },
    nodeVersion: "v24.0.0",
    resolveInstalledRuntime: async () => ({ sdkResolved: true, nativeBinaryAvailable: true }),
    probeReadiness: async () => ({ state: "responding", httpStatus: 200 }),
    credentialStore: { backend: "secret-service", has: async () => true },
    policyReader: async () => { throw Object.assign(new Error("missing"), { code: "POLICY_MISSING" }); },
  });
  assert.equal(doctorChecks.find(item => item.id === "readiness").code, "RUNTIME_RUNNING");
  assert.equal(doctorChecks.find(item => item.id === "readiness").evidence.ownerVerified, true);

  const stopped = await stopBackgroundRuntime({
    stateFile: path.join(stateDirectory, "runtime.json"),
    timeoutMs: 20_000,
    pollIntervalMs: 100,
  });
  started = false;
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
  assert.deepEqual(await fs.stat(path.join(stateDirectory, "runtime.json")).then(() => true, () => false), false);
  assert.equal(await bindProbe(8080), true);
  console.log("BACKGROUND RUNTIME CHECKS OK (start, status, stop)");
} catch (error) {
  console.error("BACKGROUND TEST FAILED");
  console.error(await fs.readFile(path.join(stateDirectory, "runtime.json"), "utf8").catch(() => "no state"));
  console.error(await fs.readFile(path.join(stateDirectory, "runtime.log"), "utf8").catch(() => "no log"));
  throw error;
} finally {
  if (started) {
    await stopBackgroundRuntime({
      stateFile: path.join(stateDirectory, "runtime.json"),
      timeoutMs: 10_000,
      pollIntervalMs: 100,
    }).catch(() => {});
  }
  await fs.rm(root, { recursive: true, force: true });
}
