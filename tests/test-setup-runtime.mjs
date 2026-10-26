import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeListeningProcessIds, startForegroundRuntime } from "../src/runtime/foreground.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";

function captureStream() {
  let output = "";
  return { write(chunk) { output += String(chunk); return true; }, get value() { return output; } };
}

function fakeProcess() {
  const processRef = new EventEmitter();
  processRef.stdout = captureStream();
  processRef.stderr = captureStream();
  return processRef;
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function rootRow(pid, executable) {
  return { pid, parent_pid: 1, executable, started_at: "2026-10-17T00:00:00.000Z" };
}

export async function runSetupRuntimeTests(fixtureRoot) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const secret = "fixture-runtime-secret-that-must-not-leak";
  const adminKey = "fixture-admin-secret";
  const tunnelBinary = path.join(fixtureRoot, "fake tunnel-client.exe");
  const packageRoot = path.join(fixtureRoot, "package root");
  await fs.writeFile(tunnelBinary, "fake executable");
  await fs.mkdir(packageRoot, { recursive: true });

  const bootstrapRoot = packageRoot;
  const scriptsRoot = path.join(bootstrapRoot, "scripts");
  await fs.mkdir(scriptsRoot, { recursive: true });
  await fs.copyFile(path.join(REPO_ROOT, "scripts", "sanitized-mcp.mjs"), path.join(scriptsRoot, "sanitized-mcp.mjs"));
  await fs.mkdir(path.join(bootstrapRoot, "src", "runtime"), { recursive: true });
  await fs.copyFile(path.join(REPO_ROOT, "src", "runtime", "env.mjs"), path.join(bootstrapRoot, "src", "runtime", "env.mjs"));
  const sanitizedOutput = path.join(bootstrapRoot, "observed.json");
  await fs.writeFile(path.join(scriptsRoot, "mcp-entry.mjs"), [
    'import fs from "node:fs/promises";',
    `await fs.writeFile(${JSON.stringify(sanitizedOutput)}, JSON.stringify({`+
      "controlPlaneKey: process.env.CONTROL_PLANE_API_KEY, openaiKey: process.env.OPENAI_API_KEY, " +
      "adminKey: process.env.OPENAI_ADMIN_KEY, controlAdmin: process.env.CONTROL_PLANE_ADMIN_API_KEY, " +
      "cloudflareTunnelToken: process.env.CLOUDFLARED_TUNNEL_TOKEN, " +
      "customToken: process.env.TUNNEL_CLIENT_CUSTOM_ACCESS_TOKEN, tunnelId: process.env.CONTROL_PLANE_TUNNEL_ID, " +
      "profileDir: process.env.TUNNEL_CLIENT_PROFILE_DIR, mcpCommand: process.env.MCP_COMMAND, " +
      "workspace: process.env.THRIFTYRELAY_CODEX_WORKSPACE, taskDir: process.env.THRIFTYRELAY_TASK_DIR, " +
      "codexHome: process.env.CODEX_HOME, runtimeKey: process.env.THRIFTYRELAY_RUNTIME_KEY, marker: process.env.TEST_SANITIZED_MARKER" +
      "}));",
  ].join("\n"));
  const bootstrap = spawnSync(process.execPath, [path.join(scriptsRoot, "sanitized-mcp.mjs")], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      CONTROL_PLANE_API_KEY: secret,
      OPENAI_API_KEY: "fixture-openai-runtime-key",
      OPENAI_ADMIN_KEY: adminKey,
      CONTROL_PLANE_ADMIN_API_KEY: "fixture-control-admin-key",
      THRIFTYRELAY_RUNTIME_KEY: "fixture-runtime-key-must-not-leak",
      CLOUDFLARED_TUNNEL_TOKEN: "fixture-cloudflare-tunnel-token",
      TUNNEL_CLIENT_CUSTOM_ACCESS_TOKEN: "fixture-extra-tunnel-token",
      CONTROL_PLANE_TUNNEL_ID: TUNNEL_ID,
      TUNNEL_CLIENT_PROFILE_DIR: path.join(fixtureRoot, "profiles"),
      MCP_COMMAND: "fixture tunnel command",
      THRIFTYRELAY_CODEX_WORKSPACE: "C:\\fixture\\workspace",
      THRIFTYRELAY_TASK_DIR: "C:\\fixture\\tasks",
      CODEX_HOME: "C:\\fixture\\codex-home",
      TEST_SANITIZED_MARKER: "fixture-preserved",
    },
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(bootstrap.stderr, "");
  const observedEnv = JSON.parse(await fs.readFile(sanitizedOutput, "utf8"));
  assert.deepEqual(observedEnv, {
    workspace: "C:\\fixture\\workspace",
    taskDir: "C:\\fixture\\tasks",
    codexHome: "C:\\fixture\\codex-home",
    marker: "fixture-preserved",
  });
  assert(!bootstrap.stdout.includes(secret));
  assert(!bootstrap.stderr.includes(secret));
  assert(!bootstrap.stdout.includes(adminKey));
  assert(!bootstrap.stderr.includes(adminKey));
  assert(!bootstrap.stdout.includes("fixture-cloudflare-tunnel-token"));
  assert(!bootstrap.stderr.includes("fixture-cloudflare-tunnel-token"));

  const psCalls = [];
  const listenerIds = await probeListeningProcessIds(8080, {
    platform: "win32",
    run: async (executable, args, options) => {
      psCalls.push({ executable, args, options });
      return { stdout: '{"pids":[6123,6123]}' };
    },
  });
  assert.deepEqual(listenerIds, [6123]);
  assert.equal(psCalls.length, 1);
  assert.equal(psCalls[0].executable, "powershell.exe");
  assert(psCalls[0].args[psCalls[0].args.indexOf("-Command") + 1].includes("-LocalPort 8080"));

  const noKeySpawn = { count: 0 };
  await assert.rejects(startForegroundRuntime({
    config: { tunnelId: TUNNEL_ID, tunnelClientPath: tunnelBinary, packageRoot },
    platform: "win32",
    healthPort: 0,
    credentialStore: { get: async () => ({ state: "missing" }) },
    spawnImpl: () => { noKeySpawn.count++; throw new Error("must not spawn"); },
    tempRoot: fixtureRoot,
  }), { code: "CREDENTIAL_NOT_CONFIGURED" });
  assert.equal(noKeySpawn.count, 0);

  let occupiedSpawnCount = 0;
  await assert.rejects(startForegroundRuntime({
    config: { tunnelId: TUNNEL_ID, tunnelClientPath: tunnelBinary, packageRoot },
    platform: "win32",
    credentialStore: { get: async () => ({ state: "registered", secret }) },
    portOwnerProbe: async port => { assert.equal(port, 8080); return [9999]; },
    spawnImpl: () => { occupiedSpawnCount++; throw new Error("must not spawn"); },
  }), { code: "LOCAL_ENDPOINT_IN_USE" });
  assert.equal(occupiedSpawnCount, 0);

  let live = true;
  let child;
  let spawnArguments;
  let redactedEnvObserved = false;
  const processRef = fakeProcess();
  const successRuntime = await startForegroundRuntime({
    config: { tunnelId: TUNNEL_ID, tunnelClientPath: tunnelBinary, packageRoot },
    env: {
      THRIFTYRELAY_CODEX_WORKSPACE: "C:\\fixture\\workspace",
      THRIFTYRELAY_TASK_DIR: "C:\\fixture\\tasks",
      CODEX_HOME: "C:\\fixture\\codex-home",
      CLOUDFLARED_TUNNEL_TOKEN: "do-not-pass-this-cloudflare-token",
      TUNNEL_CLIENT_CUSTOM_ACCESS_TOKEN: "do-not-pass-this-extra-tunnel-token",
      OPENAI_API_KEY: "do-not-pass-this-alternate-key",
      OPENAI_ADMIN_KEY: adminKey,
      CONTROL_PLANE_ADMIN_API_KEY: "do-not-pass-this-admin-key",
      THRIFTYRELAY_RUNTIME_KEY: "do-not-pass-this-runtime-key",
      CONTROL_PLANE_TUNNEL_ID: "old-tunnel-id",
      MCP_COMMAND: "old command",
      MCP_SERVER_URL: "https://invalid.fixture/mcp",
    },
    platform: "win32",
    credentialStore: { get: async () => ({ state: "registered", secret }) },
    processRef,
    tempRoot: fixtureRoot,
    healthPort: 0,
    startupTimeoutMs: 1000,
    pollIntervalMs: 1,
    cleanupAttempts: 3,
    cleanupIntervalMs: 0,
    spawnImpl: (executable, args, options) => {
      child = fakeChild(6123);
      spawnArguments = { executable, args, options };
      const childEnv = options.env;
      redactedEnvObserved = childEnv.CONTROL_PLANE_API_KEY === secret &&
        childEnv.OPENAI_API_KEY === undefined && childEnv.OPENAI_ADMIN_KEY === undefined &&
        childEnv.CONTROL_PLANE_ADMIN_API_KEY === undefined && childEnv.CONTROL_PLANE_TUNNEL_ID === undefined &&
        childEnv.CLOUDFLARED_TUNNEL_TOKEN === undefined &&
        childEnv.TUNNEL_CLIENT_CUSTOM_ACCESS_TOKEN === undefined && childEnv.MCP_COMMAND === undefined &&
        childEnv.MCP_SERVER_URL === undefined &&
        childEnv.THRIFTYRELAY_RUNTIME_KEY === undefined &&
        childEnv.THRIFTYRELAY_CODEX_WORKSPACE === "C:\\fixture\\workspace" &&
        childEnv.THRIFTYRELAY_TASK_DIR === "C:\\fixture\\tasks" &&
        childEnv.CODEX_HOME === "C:\\fixture\\codex-home";
      const simulatedMcp = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "sanitized-mcp.mjs")], {
        encoding: "utf8", windowsHide: true, env: childEnv,
      });
      assert.equal(simulatedMcp.status, 0, simulatedMcp.stderr);
      const simulatedMcpEnv = JSON.parse(readFileSync(sanitizedOutput, "utf8"));
      assert.deepEqual(simulatedMcpEnv, {
        workspace: "C:\\fixture\\workspace",
        taskDir: "C:\\fixture\\tasks",
        codexHome: "C:\\fixture\\codex-home",
      });
      assert(!simulatedMcp.stdout.includes(secret));
      assert(!simulatedMcp.stderr.includes(secret));
      const urlFile = args[args.indexOf("--health.url-file") + 1];
      fs.writeFile(urlFile, "http://127.0.0.1:49123\n", "utf8").then(() => child.emit("spawn"));
      child.stdout.write(secret.slice(0, 9));
      child.stdout.write(secret.slice(9));
      child.stderr.write(`tunnel diagnostic ${secret}`);
      return child;
    },
    processProbe: async () => live ? [rootRow(6123, tunnelBinary)] : [],
    portOwnerProbe: async port => { assert.equal(port, 49123); return live ? [6123] : []; },
    fetchImpl: async input => {
      assert.equal(String(input), "http://127.0.0.1:49123/readyz");
      return { status: 200, body: { cancel: async () => {} } };
    },
    run: async (executable, args) => {
      assert.match(executable, /\\System32\\taskkill\.exe$/i);
      assert.deepEqual(args, ["/PID", "6123", "/T", "/F"]);
      live = false;
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", null, "SIGTERM");
      return { stdout: "SUCCESS" };
    },
  });
  assert.equal(successRuntime.pid, 6123);
  assert.equal(successRuntime.healthUrl, "http://127.0.0.1:49123/readyz");
  assert.equal(redactedEnvObserved, true);
  assert.equal(spawnArguments.executable, tunnelBinary);
  assert.deepEqual(spawnArguments.args.slice(0, 4), [
    "run", "--control-plane.tunnel-id", TUNNEL_ID, "--mcp.command",
  ]);
  assert.equal(spawnArguments.args[spawnArguments.args.indexOf("--health.listen-addr") + 1], "127.0.0.1:0");
  const mcpCommand = spawnArguments.args[spawnArguments.args.indexOf("--mcp.command") + 1];
  assert(mcpCommand.includes(process.execPath));
  assert(mcpCommand.includes(path.join(packageRoot, "scripts", "sanitized-mcp.mjs")));
  assert(!spawnArguments.args.join(" ").includes(secret));
  assert(!JSON.stringify(spawnArguments.options).includes(secret));
  assert(!JSON.stringify(spawnArguments.options).includes("do-not-pass-this-runtime-key"));

  const running = successRuntime.waitForExit({ processRef });
  processRef.emit("SIGINT");
  assert.deepEqual(await running, { exitCode: 0, code: "RUNTIME_STOPPED" });
  await new Promise(resolve => setImmediate(resolve));
  assert(!processRef.stdout.value.includes(secret));
  assert(!processRef.stderr.value.includes(secret));
  assert(processRef.stdout.value.includes("[REDACTED]"));
  assert(processRef.stderr.value.includes("[REDACTED]"));
  assert.equal(live, false);

  for (const scenario of [
    {
      name: "foreign listener", expected: "RUNTIME_OWNER_MISMATCH",
      ownerProbe: async () => [7777], writesHealthUrl: true,
    },
    {
      name: "startup timeout", expected: "RUNTIME_READINESS_TIMEOUT",
      ownerProbe: async () => [], writesHealthUrl: false,
    },
  ]) {
    let scenarioLive = true;
    let scenarioChild;
    let stopCalls = 0;
    await assert.rejects(startForegroundRuntime({
      config: { tunnelId: TUNNEL_ID, tunnelClientPath: tunnelBinary, packageRoot },
      env: {},
      platform: "win32",
      credentialStore: { get: async () => ({ state: "registered", secret }) },
      processRef: fakeProcess(),
      tempRoot: fixtureRoot,
      healthPort: 0,
      startupTimeoutMs: scenario.expected === "RUNTIME_READINESS_TIMEOUT" ? 25 : 500,
      pollIntervalMs: 2,
      cleanupAttempts: 3,
      cleanupIntervalMs: 0,
      spawnImpl: (_executable, args) => {
        scenarioChild = fakeChild(6124);
        if (scenario.writesHealthUrl) {
          const urlFile = args[args.indexOf("--health.url-file") + 1];
          fs.writeFile(urlFile, "http://127.0.0.1:49124\n", "utf8").then(() => scenarioChild.emit("spawn"));
        } else queueMicrotask(() => scenarioChild.emit("spawn"));
        return scenarioChild;
      },
      processProbe: async () => scenarioLive ? [rootRow(6124, tunnelBinary)] : [],
      portOwnerProbe: scenario.ownerProbe,
      fetchImpl: async () => ({ status: 200 }),
      run: async (_executable, args) => {
        stopCalls++;
        assert.deepEqual(args, ["/PID", "6124", "/T", "/F"]);
        scenarioLive = false;
        scenarioChild.emit("exit", null, "SIGKILL");
        return { stdout: "SUCCESS" };
      },
    }), { code: scenario.expected }, scenario.name);
    assert.equal(stopCalls, 1, `${scenario.name}: owned process tree should be stopped`);
    assert.equal(scenarioLive, false, `${scenario.name}: fake process should be stopped`);
  }

  const failedProcessRef = fakeProcess();
  const failedSpawnChild = fakeChild(undefined);
  await assert.rejects(startForegroundRuntime({
    config: { tunnelId: TUNNEL_ID, tunnelClientPath: tunnelBinary, packageRoot },
    platform: "win32",
    credentialStore: { get: async () => ({ state: "registered", secret }) },
    processRef: failedProcessRef,
    tempRoot: fixtureRoot,
    healthPort: 0,
    spawnImpl: () => {
      queueMicrotask(() => failedSpawnChild.emit("error", new Error(secret)));
      return failedSpawnChild;
    },
  }), { code: "RUNTIME_TUNNEL_START_FAILED" });
  assert(!failedProcessRef.stderr.value.includes(secret));

  console.log("FOREGROUND RUNTIME CHECKS OK (sanitized import, fake tunnel, health/PID ownership, key redaction, Ctrl+C, startup failure and timeout)");
}
