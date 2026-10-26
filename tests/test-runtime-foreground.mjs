import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { startForegroundRuntimeWithRecord } from "../src/runtime/foreground-record.mjs";
import { readRuntimeState } from "../src/runtime/state.mjs";
import { stopBackgroundRuntime } from "../src/runtime/background.mjs";
import { bindProbe } from "../src/runtime/listener.mjs";

const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";

if (process.platform !== "linux") {
  console.log("SKIP: foreground state integration runs on Linux");
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.homedir(), ".thriftyrelay-fg-test-"));
const stateDirectory = path.join(root, "state");
const tunnelFile = path.join(root, "fake-tunnel.mjs");
const repository = path.resolve(import.meta.dirname, "..");
let started = false;
let runtime = null;
let processRef = null;

const tunnelSource = `#!/usr/bin/env node
import http from "node:http";
const server = http.createServer((request, response) => {
  if (request.url === "/readyz") { response.writeHead(200); response.end("ok"); return; }
  response.writeHead(503); response.end("not ready");
});
server.listen(8080, "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

try {
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  await fs.writeFile(tunnelFile, tunnelSource, { mode: 0o700 });
  await fs.chmod(tunnelFile, 0o700);
  const config = {
    tunnelId: TUNNEL_ID,
    tunnelClientPath: tunnelFile,
    workspace: root,
    taskDirectory: path.join(root, "tasks"),
    packageRoot: repository,
  };
  const env = { ...process.env, THRIFTYRELAY_RUNTIME_KEY: "fixture-runtime-key" };
  const stateFile = path.join(stateDirectory, "runtime.json");
  processRef = new EventEmitter();
  processRef.stdout = process.stdout;
  processRef.stderr = process.stderr;
  processRef.off = processRef.removeListener.bind(processRef);

  runtime = await startForegroundRuntimeWithRecord({
    config,
    env,
    platform: "linux",
    directory: stateDirectory,
    stateFile,
    packageRoot: repository,
    processRef,
    credentialStore: { get: async () => ({ state: "registered", secret: "fixture-runtime-key" }) },
    startupTimeoutMs: 20_000,
  });
  started = true;
  const running = await readRuntimeState(stateFile);
  assert.equal(running.state, "running");
  assert.equal(running.mode, "foreground");
  assert.equal(running.ownerVerified, true);
  assert.equal(running.supervisorPid, process.pid);

  const waiting = runtime.waitForExit({ processRef });
  processRef.emit("SIGINT", "SIGINT");
  assert.deepEqual(await waiting, { exitCode: 130, code: "RUNTIME_STOPPED" });
  started = false;
  const stopped = await readRuntimeState(stateFile);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.cleanup, "complete");

  // A foreground CLI in another process is the same supervisor protocol: `stop`
  // must be able to signal it and wait for its terminal record.
  const childDirectory = path.join(root, "child-state");
  const childStateFile = path.join(childDirectory, "runtime.json");
  const helper = path.join(root, "foreground-child.mjs");
  await fs.mkdir(childDirectory, { mode: 0o700 });
  await fs.writeFile(helper, [
    `import { startForegroundRuntimeWithRecord } from ${JSON.stringify(pathToFileURL(path.join(repository, "src", "runtime", "foreground-record.mjs")).href)};`,
    `const runtime = await startForegroundRuntimeWithRecord({`,
    `  config: ${JSON.stringify(config)},`,
    `  platform: "linux",`,
    `  directory: ${JSON.stringify(childDirectory)},`,
    `  stateFile: ${JSON.stringify(childStateFile)},`,
    `  packageRoot: ${JSON.stringify(repository)},`,
    `  credentialStore: { get: async () => ({ state: "registered", secret: "fixture-runtime-key" }) },`,
    `  startupTimeoutMs: 20000,`,
    `});`,
    `process.stdout.write("STARTED\\n");`,
    `const result = await runtime.waitForExit();`,
    `process.exitCode = result.exitCode;`,
  ].join("\n"), { mode: 0o700 });
  const child = spawn(process.execPath, [helper], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
  let childOutput = "";
  let childError = "";
  child.stdout.on("data", chunk => { childOutput += String(chunk); });
  child.stderr.on("data", chunk => { childError += String(chunk); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`foreground child did not start: ${childError}`)), 10_000);
      const check = () => {
        if (childOutput.includes("STARTED")) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on("data", check);
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`foreground child exited early (${code}): ${childError}`)); });
      check();
    });
    const childStop = await stopBackgroundRuntime({
      stateFile: childStateFile,
      timeoutMs: 20_000,
      pollIntervalMs: 100,
    });
    assert.equal(childStop.ok, true);
    assert.equal(childStop.stopped, true);
    const childExit = await new Promise((resolve, reject) => {
      if (child.exitCode !== null) { resolve(child.exitCode); return; }
      const timer = setTimeout(() => reject(new Error("foreground child did not exit")), 10_000);
      child.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(childExit, 143);
    assert.equal(await fs.stat(childStateFile).then(() => true, () => false), false);
    assert.equal(await bindProbe(8080), true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  console.log("FOREGROUND STATE CHECKS OK (running record, SIGINT 130, stopped record, external stop)");
} finally {
  if (started && runtime && processRef) {
    processRef.emit("SIGTERM", "SIGTERM");
    await runtime.waitForExit({ processRef }).catch(() => {});
  }
  await fs.rm(root, { recursive: true, force: true });
}
