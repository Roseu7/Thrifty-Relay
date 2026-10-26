import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { collectDoctorChecks, probeLoopback, readScheduledTasks, resolveInstalledRuntime } from "../src/cli/doctor.mjs";
import { runCli } from "../scripts/cli.mjs";
import { runSetup as configureSetup, prepareTempWorkspace, createConsolePrompts } from "../src/cli/setup.mjs";
import { readSetupConfig, updateSetupConfig } from "../src/config.mjs";
import { createCredentialStore } from "../src/platform/index.mjs";
import { startForegroundRuntime } from "../src/runtime/foreground.mjs";
import { withSpinner } from "../src/cli/spinner.mjs";
import { validateTaskSnapshot } from "../scripts/mcp-control.mjs";
import { runSetupRuntimeTests } from "./test-setup-runtime.mjs";
import { translate } from "../src/i18n/index.mjs";

function captureStream(isTTY = false) {
  let value = "";
  return {
    isTTY,
    write(chunk) { value += String(chunk); return true; },
    get value() { return value; },
  };
}

function runSetup(options) {
  const forbidden = async () => assert.fail("setup tests must inject every Windows launcher/task operation");
  let textPrompts = 0;
  let lastMessage = "";
  return configureSetup({
    launcherInstaller: forbidden, taskReader: forbidden, taskInstaller: forbidden,
    taskStarter: forbidden, taskStopper: forbidden,
    runtimeStarter: forbidden, readinessProbe: forbidden,

    ...options,
    // A native absolute store keeps Windows path spelling out of POSIX cwd resolution.
    env: { ...process.env, THRIFTYRELAY_TASK_DIR: path.join(options.home || os.tmpdir(), "tasks"), ...options.env },
    prompts: {
      ...options.prompts,
      text: (...args) => {
        assert(++textPrompts <= 32, `setup fixture exhausted its answers: ${args[0]} ${lastMessage}`);
        return options.prompts.text(...args);
      },
      write: message => { lastMessage = message; options.prompts.write(message); },
    },
  });
}

function makePowerShell(rows, calls = []) {
  return async script => {
    calls.push(script);
    const requested = ["ThriftyRelay MCP"].filter(name => script.includes(`'${name}'`));
    const tasks = rows.filter(row => requested.includes(row.name));
    return JSON.stringify({ tasks });
  };
}

async function invokeCli({ configPath, rows = [], probeResult = { state: "stopped" }, ...options } = {}) {
  const stdout = captureStream();
  const stderr = captureStream(options.stderrIsTTY === true);
  const scripts = [];
  const env = { THRIFTYRELAY_CONFIG_PATH: configPath, ...(options.ci ? { CI: "1" } : {}) };
  const exit = await runCli({
    argv: options.argv || ["doctor", "--lang", "en", "--json"],
    env,
    platform: "win32",
    home: path.dirname(configPath),
    stdout,
    stderr,
    collectChecks: doctorOptions => collectDoctorChecks({
      ...doctorOptions,
      nodeVersion: "v22.0.0",
      resolveInstalledRuntime: async () => ({ sdkResolved: true, nativeBinaryAvailable: true }),
      runPowerShell: makePowerShell(rows, scripts),
      probeReadiness: options.probeReadiness || (async () => probeResult),
      credentialStore: options.credentialStore || { has: async () => true },
      policyReader: options.policyReader || (async () => {
        throw Object.assign(new Error("POLICY_MISSING"), { code: "POLICY_MISSING" });
      }),
    }),
  });
  return { exit, stdout: stdout.value, stderr: stderr.value, scripts };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-cli-"));
const originalCwd = process.cwd();
// Windows paths are relative filenames on POSIX; keep those mocked setup outputs in the fixture.
const setupCwd = await fs.mkdtemp(path.join(process.env.THRIFTYRELAY_TEMP_DIR || os.tmpdir(), "thriftyrelay-setup-paths-"));
process.chdir(setupCwd);
try {
  // The vendored Codex binary is a per platform optional dependency, so it exists only
  // where npm install ran. The SDK must resolve everywhere; the binary answer is checked
  // against what this checkout actually has, which still fails if the vendored path
  // layout changes. A system the table does not cover must never claim a binary.
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const hostRuntime = await resolveInstalledRuntime({ platform: process.platform, arch: process.arch });
  assert.equal(hostRuntime.sdkResolved, true, "the Codex SDK resolves on every supported system");
  const vendored = await fs.readdir(path.join(packageRoot, "node_modules", "@openai"))
    .then(entries => entries.includes(`codex-${process.platform}-${process.arch}`), () => false);
  if (vendored) {
    assert.equal(hostRuntime.nativeBinaryAvailable, true, "an installed Codex binary package must be found by the resolver");
  }
  assert.deepEqual(await resolveInstalledRuntime({ platform: "plan9", arch: "x64" }), {
    sdkResolved: true,
    nativeBinaryAvailable: false,
  });

  const taskQuery = await readScheduledTasks({
    taskNames: ["ThriftyRelay MCP"],
    platform: "win32",
    run: async script => {
      assert(script.includes("'ThriftyRelay MCP'"));
      assert(!script.includes("'Unrelated service'"));
      return JSON.stringify({ tasks: [{ name: "ThriftyRelay MCP", path: "\\", state: "Ready", actionCount: 1, actionValid: true }] });
    },
  });
  assert.deepEqual(taskQuery, { ok: true, tasks: [{ count: 1, name: "ThriftyRelay MCP", path: "\\", state: "Ready", actionCount: 1, actionValid: true }] });
  assert.deepEqual(validateTaskSnapshot({ task: taskQuery.tasks[0] }), { ok: true, taskName: "ThriftyRelay MCP", state: "Ready" });
  assert.equal(validateTaskSnapshot({ task: { ...taskQuery.tasks[0], actionValid: false } }).ok, false);

  const configPath = path.join(tempRoot, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    mode: "on-demand-task",
    workspace: "C:\\fixture\\workspace",
    auth: { secret: "fixture-secret-never-output" },
  }));
  const taskRows = [{ name: "ThriftyRelay MCP", path: "\\", state: "Ready", actionCount: 1, actionValid: true }];
  const stopped = await invokeCli({ configPath, rows: taskRows });
  const stoppedChecks = JSON.parse(stopped.stdout);
  assert.equal(stopped.exit, 0);
  assert.deepEqual(stoppedChecks.map(item => item.id), ["environment", "config", "credentials", "startup", "readiness", "policy"]);
  assert.equal(stoppedChecks[0].code, "ENV_READY");
  assert.equal(stoppedChecks[1].code, "CONFIG_READY");
  assert.equal(stoppedChecks[2].code, "CREDENTIAL_REGISTERED");
  assert.equal(stoppedChecks[3].code, "STARTUP_TASK_REGISTERED");
  assert.equal(stoppedChecks[4].code, "STOPPED_IDLE");
  assert.equal(stoppedChecks[4].evidence.ready, false);
  assert.equal(stoppedChecks[5].status, "WARN");
  assert.equal(stoppedChecks[5].code, "POLICY_UNREGISTERED");
  assert(!stopped.stdout.includes("fixture-secret-never-output"));
  assert.equal(stopped.stderr, "");
  assert.equal(stopped.scripts.length, 1);
  assert(stopped.scripts[0].includes("'ThriftyRelay MCP'"));
  assert(!stopped.scripts[0].includes("'Unrelated service'"));

  const missingCredential = await invokeCli({ configPath, rows: taskRows, credentialStore: { has: async () => false } });
  assert.equal(missingCredential.exit, 1);
  assert.equal(JSON.parse(missingCredential.stdout)[2].code, "CREDENTIAL_UNCONFIGURED");
  const unavailableCredential = await invokeCli({
    configPath,
    rows: taskRows,
    credentialStore: { has: async () => { throw new Error("raw fixture error"); } },
  });
  assert.equal(unavailableCredential.exit, 2);
  assert.equal(JSON.parse(unavailableCredential.stdout)[2].code, "CREDENTIAL_BACKEND_ERROR");
  assert(!unavailableCredential.stdout.includes("raw fixture error"));
  assert(!unavailableCredential.stderr.includes("raw fixture error"));

  const respondingServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ThriftyRelay local fixture");
  });
  await new Promise((resolve, reject) => {
    respondingServer.once("error", reject);
    respondingServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = respondingServer.address();
    const observed = await probeLoopback({ url: `http://127.0.0.1:${address.port}/readyz` });
    assert.deepEqual(observed, { state: "responding", httpStatus: 200 });
    const endpoint = await invokeCli({
      configPath,
      rows: taskRows,
      probeReadiness: () => probeLoopback({ url: `http://127.0.0.1:${address.port}/readyz` }),
      stderrIsTTY: true,
    });
    const endpointChecks = JSON.parse(endpoint.stdout);
    assert.equal(endpoint.exit, 2);
    assert.equal(endpointChecks[4].status, "UNKNOWN");
    assert.equal(endpointChecks[4].code, "LOCAL_ENDPOINT_UNVERIFIED");
    assert.equal(endpointChecks[4].evidence.ready, false);
    assert.equal(endpoint.stderr, "");
  } finally {
    await new Promise((resolve, reject) => respondingServer.close(error => error ? reject(error) : resolve()));
  }

  await fs.writeFile(configPath, JSON.stringify({ mode: "on-login-task", workspace: "C:\\fixture\\workspace" }));
  const unexpectedStop = await invokeCli({ configPath, rows: taskRows, probeResult: { state: "stopped" } });
  const unexpectedStopChecks = JSON.parse(unexpectedStop.stdout);
  assert.equal(unexpectedStop.exit, 1);
  assert.equal(unexpectedStopChecks[4].code, "LOCAL_RUNTIME_STOPPED");

  await fs.writeFile(configPath, JSON.stringify({ mode: "foreground", workspace: "C:\\fixture\\workspace" }));
  const foreground = await invokeCli({ configPath, rows: [], probeResult: { state: "stopped" } });
  const foregroundChecks = JSON.parse(foreground.stdout);
  assert.equal(foreground.exit, 0);
  assert.equal(foregroundChecks[3].code, "STARTUP_FOREGROUND_CONFIGURED");
  assert.equal(foregroundChecks[4].code, "STOPPED_IDLE");
  assert.equal(foreground.scripts.length, 0);

  await fs.rm(configPath, { force: true });
  const legacy = await invokeCli({
    configPath,
    rows: [{ name: "ThriftyRelay MCP", path: "\\", state: "Running", actionCount: 1, actionValid: true }],
  });
  const legacyChecks = JSON.parse(legacy.stdout);
  assert.equal(legacy.exit, 2);
  assert.equal(legacyChecks[1].code, "CONFIG_NOT_INSTALLED");
  assert.equal(legacyChecks[3].status, "WARN");
  assert.equal(legacyChecks[3].code, "STARTUP_TASK_DISCOVERED");
  assert.equal(legacyChecks[3].evidence.state, "Running");

  await fs.writeFile(configPath, '{"mode":"foreground","workspace":"C:\\fixture\\workspace","token":"sensitive-config-value",');
  const malformed = await invokeCli({ configPath, rows: [] });
  const malformedChecks = JSON.parse(malformed.stdout);
  assert.equal(malformed.exit, 1);
  assert.equal(malformedChecks[1].code, "CONFIG_INVALID");
  assert(!malformed.stdout.includes("sensitive-config-value"));

  const fixtureRuntimeKey = "fixture-runtime-key-only";
  const fakeVault = new Map();
  const mockedCredentials = createCredentialStore({
    platform: "win32",
    env: {},
    run: async (script, input) => {
      assert(script.includes("CredWriteW") && script.includes("CredReadW"));
      assert(!script.includes(fixtureRuntimeKey));
      const payload = JSON.parse(input);
      if (payload.operation === "write") {
        const value = Buffer.from(payload.secret_b64, "base64").toString("utf8");
        assert.equal(value, fixtureRuntimeKey);
        fakeVault.set(payload.target, value);
        return JSON.stringify({ ok: true, exists: true });
      }
      if (payload.operation === "exists") return JSON.stringify({ ok: true, exists: fakeVault.has(payload.target) });
      return fakeVault.has(payload.target)
        ? JSON.stringify({ ok: true, exists: true, secret_b64: Buffer.from(fakeVault.get(payload.target), "utf8").toString("base64") })
        : JSON.stringify({ ok: true, exists: false });
    },
  });
  assert.equal(await mockedCredentials.has(), false);
  await mockedCredentials.set(fixtureRuntimeKey);
  assert.equal(await mockedCredentials.has(), true);
  assert.deepEqual(await mockedCredentials.get(), { state: "registered", secret: fixtureRuntimeKey });
  const failedCredentialBackend = createCredentialStore({
    platform: "win32",
    env: {},
    run: async () => { throw new Error(fixtureRuntimeKey); },
  });
  await assert.rejects(failedCredentialBackend.has(), error => error.code === "CREDENTIAL_BACKEND_ERROR" && !error.message.includes(fixtureRuntimeKey));

  const configWritePath = path.join(tempRoot, "setup-config.json");
  await fs.writeFile(configWritePath, JSON.stringify({
    language: "en",
    mode: "foreground",
    workspace: "C:\\fixture\\workspace",
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    tunnelClientPath: "C:\\fixture\\tunnel-client.exe",
    customOption: { retained: true },
  }));
  await updateSetupConfig(configWritePath, { language: "ja" }, { platform: "win32", removeKeys: ["mode"] });
  const savedSettings = JSON.parse(await fs.readFile(configWritePath, "utf8"));
  assert.equal(savedSettings.language, "ja");
  assert.equal(savedSettings.mode, undefined);
  assert.deepEqual(savedSettings.customOption, { retained: true });
  assert(!JSON.stringify(savedSettings).includes(fixtureRuntimeKey));
  await fs.writeFile(configWritePath, "{broken");
  await assert.rejects(updateSetupConfig(configWritePath, { language: "en" }, { platform: "win32" }), { code: "CONFIG_INVALID" });
  assert.equal(await fs.readFile(configWritePath, "utf8"), "{broken");
  const configWithSecretField = JSON.stringify({ language: "en", apiKey: fixtureRuntimeKey });
  await fs.writeFile(configWritePath, configWithSecretField);
  await assert.rejects(updateSetupConfig(configWritePath, { language: "ja" }, { platform: "win32" }), { code: "CONFIG_SECRET_FIELD_FORBIDDEN" });
  assert.equal(await fs.readFile(configWritePath, "utf8"), configWithSecretField);

  const setupRoot = path.join(tempRoot, "setup-flow");
  const workspace = path.join(setupRoot, "workspace");
  const tunnelBinary = path.join(setupRoot, "tunnel-client.exe");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(tunnelBinary, "mock tunnel binary");
  const setupConfigPath = path.join(setupRoot, "config.json");
  await fs.writeFile(setupConfigPath, JSON.stringify({ language: "en", workspace, retained: "setting" }));
  const promptOrder = [];
  const setupPrompts = {
    async language(defaultLanguage) { promptOrder.push("language"); assert.equal(defaultLanguage, "en"); return "ja"; },
    async text(prompt, defaultValue) {
      promptOrder.push(prompt.includes("作業ディレクトリ") ? "workspace" : /tunnel id|トンネルID/i.test(prompt) ? "tunnel-id" : "tunnel-client");
      if (/tunnel id|トンネルID/i.test(prompt)) {
        assert.equal(defaultValue, undefined, "first setup must not display a tunnel ID default");
        return "tunnel_0123456789abcdef0123456789abcdef";
      }
      return "";
    },
    async yesNo(prompt) {
      promptOrder.push(prompt.includes("公式Codex") ? "codex-login" : prompt.includes("ログオン時") ? "auto-start" : "manual-task");
      return [true, false, false][promptOrder.filter(item => ["codex-login", "auto-start", "manual-task"].includes(item)).length - 1];
    },
    async secret() { promptOrder.push("runtime-key"); return fixtureRuntimeKey; },
    write(value) { assert(!String(value).includes(fixtureRuntimeKey)); },
  };
  const stored = [];
  let foregroundStarts = 0;
  const fakeRuntime = { waitForExit: async () => ({ exitCode: 0, code: "RUNTIME_STOPPED" }) };
  const progressLabels = [];
  const setupResult = await runSetup({
    configFile: setupConfigPath,
    initialLanguage: "en",
    platform: "win32",
    home: setupRoot,
    cwd: setupRoot,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: setupPrompts,
    credentialStore: { has: async () => false, set: async value => { stored.push(value); } },
    runtimeStarter: async options => {
      foregroundStarts++;
      assert.equal(options.config.mode, "foreground");
      return fakeRuntime;
    },
    tunnelResolver: async () => tunnelBinary,

    withProgress: async (label, operation) => { progressLabels.push(label); return operation(); },
  });
  assert.equal(setupResult.ok, true);
  assert.equal(setupResult.code, "runtimeReady");
  assert.equal(setupResult.runtime, fakeRuntime);
  assert.equal(setupResult.saved, true);
  assert.deepEqual(promptOrder.slice(0, 6), ["language", "workspace", "codex-login", "tunnel-id", "tunnel-client", "auto-start"]);
  assert.deepEqual(stored, [fixtureRuntimeKey]);
  assert.equal(foregroundStarts, 1);
  assert.equal(progressLabels.length, 1);
  assert(progressLabels[0].includes("ローカルの応答"));
  const setupSavedConfig = JSON.parse(await fs.readFile(setupConfigPath, "utf8"));
  assert.equal(setupSavedConfig.retained, "setting");
  assert.equal(setupSavedConfig.mode, "foreground");
  assert.equal(setupResult.tempWorkspace, setupSavedConfig.tempWorkspace);
  assert.equal(path.win32.isAbsolute(setupSavedConfig.tempWorkspace), true);
  assert.equal(await fs.stat(setupSavedConfig.tempWorkspace).then(info => info.isDirectory(), () => false), true);
  assert(!JSON.stringify(setupSavedConfig).includes(fixtureRuntimeKey));
  assert.equal(await fs.stat(path.join(setupRoot, "profiles")).then(() => true, () => false), false);

  const migrationConfigPath = path.join(setupRoot, "migration-config.json");
  await fs.writeFile(migrationConfigPath, JSON.stringify({ language: "en", workspace }));
  const migratedKeys = [];
  let migrationSecretPrompts = 0;
  const migrationResult = await runSetup({
    configFile: migrationConfigPath,
    initialLanguage: "en",
    platform: "win32",
    home: setupRoot,
    cwd: setupRoot,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: {
      language: async () => "en",
      text: async prompt => prompt.toLowerCase().includes("tunnel id") ? "tunnel_0123456789abcdef0123456789abcdef" : "",
      yesNo: async prompt => {
        if (/logon|sign[ -]in to Windows/i.test(prompt)) return false;
        if (/manual startup/i.test(prompt)) return false;
        return true;
      },
      secret: async () => { migrationSecretPrompts++; return "explicit-runtime-key"; },
      write: () => {},
    },
    credentialStore: { has: async () => false, set: async value => { migratedKeys.push(value); } },
    tunnelResolver: async () => tunnelBinary,

    runtimeStarter: async () => fakeRuntime,
  });
  assert.equal(migrationResult.code, "runtimeReady");
  assert.deepEqual(migratedKeys, ["explicit-runtime-key"]);
  assert.equal(migrationSecretPrompts, 1);
  const yesNoHints = [];
  const tunnelIdDefaults = [];
  const repeatedAnswers = [true, false, false, true];
  const repeatedSetup = await runSetup({
    configFile: setupConfigPath,
    initialLanguage: "en",
    platform: "win32",
    home: setupRoot,
    cwd: setupRoot,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: {
      language: async current => current,
      text: async (prompt, defaultValue) => {
        if (/tunnel id|トンネルID/i.test(prompt)) tunnelIdDefaults.push(defaultValue);
        return "";
      },
      yesNo: async (_prompt, recommendation) => { yesNoHints.push(recommendation); return repeatedAnswers.shift(); },
      secret: async () => assert.fail("saved credential should be reused"),
      write: () => {},
    },
    credentialStore: { has: async () => true, set: async () => assert.fail("saved credential should not be overwritten") },
    runtimeStarter: async () => fakeRuntime,
    tunnelResolver: async () => assert.fail("saved tunnel binary should be reused"),

    withProgress: async (_label, operation) => operation(),
  });
  assert.equal(repeatedSetup.code, "runtimeReady");
  assert.deepEqual(tunnelIdDefaults, ["tunnel_0123...cdef"]);
  assert.equal(repeatedSetup.config.tunnelId, "tunnel_0123456789abcdef0123456789abcdef", "Enter must reuse the full saved ID");
  assert.equal(yesNoHints.length, 4);
  assert(yesNoHints.every(value => typeof value !== "boolean"), "yes/no questions must not receive default answers");

  const taskConfigPath = path.join(setupRoot, "task-config.json");
  await fs.writeFile(taskConfigPath, JSON.stringify({ language: "en", workspace }));
  const taskStored = [];
  const setupOrder = [];
  const taskPrompts = {
    language: async () => "en",
    text: async prompt => prompt.toLowerCase().includes("tunnel id") ? "tunnel_0123456789abcdef0123456789abcdef" : "",
    yesNo: async () => true,
    secret: async () => fixtureRuntimeKey,
    write: () => {},
  };
  let installedTask;
  let startedTask;
  const taskModeResult = await runSetup({
    configFile: taskConfigPath,
    initialLanguage: "en",
    platform: "win32",
    home: setupRoot,
    cwd: setupRoot,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: taskPrompts,
    credentialStore: { has: async () => false, set: async value => { taskStored.push(value); } },
    tunnelResolver: async () => tunnelBinary,

    taskReader: async () => ({ name: "ThriftyRelay MCP", state: "Running" }),
    taskStopper: async options => {
      setupOrder.push("stop");
      assert.equal(options.config.mode, "on-login-task");
      return { ok: true };
    },
    launcherInstaller: async options => {
      setupOrder.push("launcher");
      assert.equal(options.config.mode, "on-login-task");
      return "C:\\fixture\\Start-ThriftyRelay.ps1";
    },
    taskInstaller: async options => {
      setupOrder.push("install");
      installedTask = options;
      return { ok: true, name: "ThriftyRelay MCP", state: "Ready", atLogon: true };
    },
    taskStarter: async options => { setupOrder.push("start"); startedTask = options; },
    readinessProbe: async () => true,
  });
  assert.equal(taskModeResult.ok, true, taskModeResult.code);
  assert.equal(taskModeResult.code, "taskInstalled");
  assert.equal(taskModeResult.saved, true);
  assert.equal(taskModeResult.task.ready, true);
  assert.equal(taskModeResult.task.atLogon, true);
  assert.equal(installedTask.launcher, "C:\\fixture\\Start-ThriftyRelay.ps1");
  assert.equal(installedTask.atLogon, true);
  assert.deepEqual(startedTask, { name: "ThriftyRelay MCP" });
  assert.deepEqual(setupOrder, ["launcher", "stop", "install", "start"]);
  assert.deepEqual(taskStored, [fixtureRuntimeKey]);
  assert.equal((await readSetupConfig(taskConfigPath, { platform: "win32" })).mode, "on-login-task");
  assert.equal(await fs.stat(path.join(setupRoot, "profiles", "local-stdio.yaml")).then(() => true, () => false), false);

  const failingTaskConfig = path.join(setupRoot, "task-failure-config.json");
  await fs.writeFile(failingTaskConfig, JSON.stringify({ language: "en", workspace }));
  const failingTask = await runSetup({
    configFile: failingTaskConfig,
    initialLanguage: "en",
    platform: "win32",
    home: setupRoot,
    cwd: setupRoot,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: taskPrompts,
    credentialStore: { has: async () => true, set: async () => {} },
    tunnelResolver: async () => tunnelBinary,
    taskReader: async () => null,
    launcherInstaller: async () => "C:\\fixture\\Start-ThriftyRelay.ps1",
    taskInstaller: async () => { throw Object.assign(new Error("TASK_INSTALL_ELEVATION_FAILED"), { code: "TASK_INSTALL_ELEVATION_FAILED" }); },
    taskStarter: async () => assert.fail("a failed install must not start the task"),
    readinessProbe: async () => assert.fail("a failed install must not probe readiness"),
  });
  assert.equal(failingTask.ok, false);
  assert.equal(failingTask.code, "SETUP_TASK_INSTALL_FAILED");
  assert.equal(await fs.stat(failingTaskConfig).then(() => true, () => false), true);
  assert.equal((await readSetupConfig(failingTaskConfig, { platform: "win32" })).mode, undefined);

  const missingIdPath = path.join(setupRoot, "missing-id-config.json");
  await fs.writeFile(missingIdPath, JSON.stringify({ language: "en" }));
  let tunnelIdPrompts = 0;
  const resumedAfterTunnelPage = await runSetup({
    configFile: missingIdPath,
    initialLanguage: "en",
    platform: "win32",
    home: setupRoot,
    cwd: setupRoot,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: {
      language: async () => "en",
      text: async prompt => {
        if (prompt.toLowerCase().includes("tunnel id")) {
          tunnelIdPrompts++;
          return tunnelIdPrompts === 1 ? "" : "tunnel_0123456789abcdef0123456789abcdef";
        }
        return "";
      },
      yesNo: async () => true,
      secret: async () => fixtureRuntimeKey,
      write: value => assert(!String(value).includes(fixtureRuntimeKey)),
    },
    credentialStore: { has: async () => false, set: async () => {} },
    tunnelResolver: async () => tunnelBinary,

    taskReader: async () => null,
    launcherInstaller: async () => "C:\\fixture\\Start-ThriftyRelay.ps1",
    taskInstaller: async () => ({ ok: true, name: "ThriftyRelay MCP", state: "Ready" }),
    taskStarter: async () => {},
    readinessProbe: async () => true,
  });
  assert.equal(resumedAfterTunnelPage.code, "taskInstalled");
  assert.equal(tunnelIdPrompts, 2);

  const corruptSetupPath = path.join(setupRoot, "corrupt.json");
  await fs.writeFile(corruptSetupPath, "not-json");
  let corruptPrompts = 0;
  const corruptSetup = await runSetup({
    configFile: corruptSetupPath,
    initialLanguage: "en",
    prompts: { language: async () => { corruptPrompts++; }, text: async () => "", yesNo: async () => false, secret: async () => "", write: () => {} },
    credentialStore: { has: async () => false, set: async () => assert.fail("corrupt config must not write credentials") },
    packageRoot: path.resolve(import.meta.dirname, ".."),
  });
  assert.equal(corruptSetup.code, "SETUP_CONFIG_INVALID");
  assert.equal(corruptSetup.detail, "CONFIG_INVALID");
  assert.equal(corruptPrompts, 0);
  assert.equal(await fs.readFile(corruptSetupPath, "utf8"), "not-json");

  // A generic CONFIG_UNAVAILABLE must still name the underlying failure, so an intermittent
  // I/O error can be told apart from a validation error after the fact.
  const ioAnswers = [true, false, false];
  const ioFailure = await runSetup({
    configFile: path.join(setupRoot, "io-failure.json"),
    initialLanguage: "en",
    platform: "win32",
    home: setupRoot,
    cwd: setupRoot,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: {
      language: async () => "en", write: () => {},
      text: async prompt => prompt.toLowerCase().includes("tunnel id") ? "tunnel_0123456789abcdef0123456789abcdef" : "",
      yesNo: async () => ioAnswers.shift(), secret: async () => "runtime-key",
    },
    credentialStore: { has: async () => true, set: async () => {} },
    tunnelResolver: async () => tunnelBinary,
    configUpdater: async () => { throw Object.assign(new Error("rename"), { code: "EPERM" }); },
  });
  assert.equal(ioFailure.code, "SETUP_CONFIG_UNAVAILABLE");
  assert.equal(ioFailure.detail, "EPERM");
  assert.equal(await fs.stat(path.join(setupRoot, "io-failure.json")).then(() => true, () => false), false);

  const retryConfig = { language: "en", workspace, tunnelClientPath: tunnelBinary,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef", tempWorkspace: path.join(setupRoot, "retry-temp") };
  const retryInputs = {
    workspace: [path.join(setupRoot, "missing-workspace"), workspace],
    binary: ["relative.exe", path.join(setupRoot, "missing.exe"), tunnelBinary],
    temp: [workspace, retryConfig.tempWorkspace],
  };
  let retryLanguages = 0, retrySaves = 0;
  const retryErrors = [];
  let retryCount = 0;
  const retrySetup = await runSetup({ configFile: path.join(setupRoot, "retry-config", "config.json"),
    platform: "win32", home: setupRoot, cwd: workspace, packageRoot: path.join(setupRoot, "fixture-package"), configReader: async () => retryConfig,
    prompts: {
      language: async () => { retryLanguages++; return "en"; },
      text: async prompt => {

        if (++retryCount > 10) throw new Error("RETRY_TEST_INPUT_EXHAUSTED " + retryErrors.join(" "));
        return prompt.includes("Codex workspace") ? retryInputs.workspace.shift()
        : prompt.includes("tunnel-client") ? retryInputs.binary.shift()
          : prompt.includes("temporary work area") ? retryInputs.temp.shift() : "";
      },
      yesNo: async prompt => !/logon|sign in|manual startup/i.test(prompt),
      secret: async () => assert.fail("retry must preserve saved credentials"),
      write: text => retryErrors.push(text),
    },
    credentialStore: { has: async () => true },
    configUpdater: async (_file, patch) => { retrySaves++; return { ...retryConfig, ...patch }; },
    runtimeStarter: async () => fakeRuntime,
  });
  assert.equal(retrySetup.ok, true);
  assert.equal(retryLanguages, 1, "path retries must not restart setup");
  assert.equal(retrySaves, 1);
  assert(Object.values(retryInputs).every(values => values.length === 0));
  assert(retryErrors.join("").includes("TEMP_OVERLAPS_WORKSPACE"));

  // Empty answers must not confirm login. Both yes/no forms accept any letter case.
  for (const [answers, expected] of [[["", "maybe", "YeS"], true], [["NO"], false]]) {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
    const output = new PassThrough(); output.isTTY = true;
    let text = "";
    output.on("data", chunk => {
      text += chunk;
      if (String(chunk).includes("[y/n]>")) {
        const answer = answers.shift(); assert.notEqual(answer, undefined);
        setImmediate(() => input.write(answer + "\r"));
      }
    });
    const prompts = createConsolePrompts({ input, output });
    try {
      assert.equal(await prompts.yesNo("Signed in?"), expected);
      assert(!/Default:|デフォルト:/.test(text));
      if (expected) assert(text.includes("y for yes"));
    } finally { prompts.close(); input.destroy(); output.destroy(); }
  }

  for (const phase of ["question", "registration", "startup", "cleanup-failure"]) {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
    const output = new PassThrough(); output.isTTY = true;
    const errors = captureStream();
    const processRef = new EventEmitter();
    let starts = 0, stops = 0, saves = 0, probes = 0;
    const cancel = () => input.write("\x03");
    const answers = ["en", "", "y", "", "", "y", "", "y"];

    const cancelled = await runCli({ argv: ["setup", "--lang", "en"], platform: "win32", home: setupRoot,
      env: { THRIFTYRELAY_CONFIG_PATH: path.join(setupRoot, "cancel-config", "config.json") },
      cwd: workspace, stdin: input, stdout: output, stderr: errors, processRef,
      credentialStore: { has: async () => true, set: async () => assert.fail("saved key must be reused") },
      promptFactory: options => {
        const prompts = createConsolePrompts(options);
        const wrapper = { ...prompts };
        for (const name of ["language", "text", "yesNo"]) wrapper[name] = (...args) => {
          const pending = prompts[name](...args);
          const answer = phase === "question" ? null : answers.shift();
          setImmediate(() => answer === null ? cancel() : input.write(answer + "\r"));
          return pending;
        };
        return wrapper;
      },
      setupRunner: options => runSetup({ ...options, packageRoot: path.join(setupRoot, "fixture-package"), configReader: async () => retryConfig,
        launcherInstaller: async () => "C:\\fixture\\launcher.ps1", taskReader: async () => null,
        taskInstaller: async () => { if (phase === "registration") cancel(); return { ok: true, name: "ThriftyRelay MCP" }; },
        configUpdater: async (_file, patch) => { saves++; return { ...retryConfig, ...patch }; },
        taskStarter: async () => { starts++; cancel(); },
        taskStopper: async () => { stops++; return { ok: phase !== "cleanup-failure" }; },
        readinessProbe: async () => { probes++; return true; },
      }),
    });
    assert.equal(cancelled, phase === "cleanup-failure" ? 1 : 130, errors.value);
    assert.equal(processRef.listenerCount("SIGINT"), 0);
    assert.equal(starts, ["startup", "cleanup-failure"].includes(phase) ? 1 : 0);
    assert.equal(stops, starts, "only the task started by this setup needs cancellation cleanup");
    assert.equal(saves, starts, "cancelled registration must not advance to saving or starting");
    assert.equal(probes, 0);
    assert(errors.value.includes(phase === "cleanup-failure" ? "SETUP_CANCEL_STOP_UNCONFIRMED" : "Setup cancelled."));
    input.destroy(); output.destroy();
  }

  {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
    const output = new PassThrough(); output.isTTY = true;
    const prompts = createConsolePrompts({ input, output });
    const pending = prompts.text("Workspace?");
    input.end();
    await assert.rejects(pending, { code: "SETUP_CANCELLED" });
    prompts.close(); output.destroy();
  }

  {
    const processRef = new EventEmitter();
    const errors = captureStream();
    assert.equal(await runCli({ argv: ["setup", "--lang", "en"],
      env: { THRIFTYRELAY_CONFIG_PATH: configPath }, stdin: captureStream(true), stdout: captureStream(true),
      stderr: errors, processRef, credentialStore: {}, promptFactory: () => ({ close() {} }),
      setupRunner: async () => ({ ok: true, language: "en", runtime: { waitForExit: async () => {
        processRef.emit("SIGINT"); return { exitCode: 130, code: "RUNTIME_STOPPED" };
      } } }),
    }), 130);
    assert(errors.value.includes("Setup cancelled."));
    assert.equal(processRef.listenerCount("SIGINT"), 0);
  }

  const entryConfig = path.join(setupRoot, "entry-invalid.json");
  await fs.writeFile(entryConfig, "invalid");
  const mcpEntry = path.resolve(import.meta.dirname, "..", "scripts", "mcp-entry.mjs");
  const sanitizedEntry = spawnSync(process.execPath, [mcpEntry], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, THRIFTYRELAY_CONFIG_PATH: entryConfig, CONTROL_PLANE_API_KEY: fixtureRuntimeKey, OPENAI_ADMIN_KEY: "fixture-admin-only" },
  });
  assert.equal(sanitizedEntry.status, 1);
  assert.equal(sanitizedEntry.stderr.trim(), "THRIFTYRELAY_RUNTIME_CONFIG_INVALID");
  assert(!sanitizedEntry.stdout.includes(fixtureRuntimeKey));
  assert(!sanitizedEntry.stderr.includes(fixtureRuntimeKey));
  assert(!sanitizedEntry.stderr.includes("fixture-admin-only"));

  let runtimeCredentialReads = 0;
  let runtimeSpawns = 0;
  await assert.rejects(startForegroundRuntime({
    config: {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      tunnelClientPath: tunnelBinary,
      packageRoot: path.resolve(import.meta.dirname, ".."),
    },
    platform: "win32",
    healthPort: 0,
    credentialStore: { get: async () => { runtimeCredentialReads++; return { state: "missing" }; } },
    spawnImpl: () => { runtimeSpawns++; throw new Error("must not spawn"); },
  }), { code: "CREDENTIAL_NOT_CONFIGURED" });
  assert.equal(runtimeCredentialReads, 1);
  assert.equal(runtimeSpawns, 0);

  const humanStdout = captureStream();
  const humanStderr = captureStream();
  const helpExit = await runCli({ argv: ["help", "--lang", "ja"], stdout: humanStdout, stderr: humanStderr });
  assert.equal(helpExit, 0);
  assert(humanStdout.value.includes("設定と資格情報"));
  assert(humanStdout.value.includes("使用例:\n  thriftyrelay setup"));
  assert(!humanStdout.value.includes("\n補足:"));
  assert.equal(humanStderr.value, "");

  // The helper commands keep their own parsers, so the CLI must hand over the arguments
  // unchanged, put back the --lang it consumed, and return the script's exit code.
  for (const [argv, script, forwarded] of [
    [["mcp", "restart", "--lang", "en"], "mcp-control.mjs", ["restart", "--lang", "en"]],
    [["--lang", "ja", "recover", "--task-dir", "/tmp/tasks"], "recover-guided.mjs", ["--task-dir", "/tmp/tasks", "--lang", "ja"]],
    [["register-policy", "--show"], "register-policy.mjs", ["--show"]],
    [["lang", "en"], "lang.mjs", ["en"]],
    [["lang", "--lang", "en"], "lang.mjs", []],
  ]) {
    const calls = [];
    const exit = await runCli({ argv, stdout: captureStream(), stderr: captureStream(),
      scriptRunner: async (file, args) => { calls.push({ file, args }); return 3; } });
    assert.equal(exit, 3);
    assert.equal(calls.length, 1);
    assert.equal(path.basename(calls[0].file), script);
    await fs.access(calls[0].file);
    assert.deepEqual(calls[0].args, forwarded);
  }

  const displayChecks = [
    ["environment", "ENV_READY"], ["config", "CONFIG_READY"],
    ["credentials", "CREDENTIAL_REGISTERED"], ["startup", "STARTUP_TASK_REGISTERED"],
    ["readiness", "RUNTIME_RUNNING"], ["policy", "POLICY_UNREGISTERED"],
  ].map(([id, code]) => ({ id, code, status: id === "policy" ? "WARN" : "PASS" }));
  for (const [code, state, status, expected] of [
    ["RUNTIME_RUNNING", "running", "PASS", "稼働中"],
    ["STOPPED_IDLE", "stopped", "PASS", "停止しています"],
    ["LOCAL_ENDPOINT_UNVERIFIED", "responding", "UNKNOWN", "未確認"],
  ]) {
    const output = captureStream();
    const checks = displayChecks.map(item => item.id === "readiness" ? { id: "readiness", code, status, evidence: { state } } : item);
    await runCli({ argv: ["status", "--lang", "ja"], stdout: output, stderr: captureStream(),
      env: { THRIFTYRELAY_CONFIG_PATH: configPath }, collectChecks: async () => checks });
    assert(output.value.includes(expected));
    assert(output.value.trim().split("\n").length <= 2);
    assert(!output.value.includes("POLICY_UNREGISTERED"));
  }
  for (const displayPlatform of ["win32", "linux", "darwin"]) {
    for (const displayLanguage of ["ja", "en"]) {
      const output = captureStream();
      assert.equal(await runCli({ argv: ["doctor", "--lang", displayLanguage],
        platform: displayPlatform, env: { THRIFTYRELAY_CONFIG_PATH: configPath },
        stdout: output, stderr: captureStream(), collectChecks: async () => displayChecks }), 0);
      const command = "thriftyrelay register-policy --file <policy.json>";
      assert(output.value.includes("`" + command + "`"));
      assert(!output.value.includes("{policyCommand}"));
      assert(output.value.includes(translate(displayLanguage, "doctor.summary", { status: translate(displayLanguage, "doctor.status.pass"), count: 5 })));
      assert(output.value.includes(translate(displayLanguage, "doctor.summary", { status: translate(displayLanguage, "doctor.status.warn"), count: 1 })));
    }
  }

  const nonInteractiveOut = captureStream();
  const nonInteractiveErr = captureStream();
  const nonInteractiveSetup = await runCli({
    argv: ["setup", "--lang", "ja"],
    env: { THRIFTYRELAY_CONFIG_PATH: configPath },
    platform: "win32",
    home: tempRoot,
    stdin: { isTTY: false },
    stdout: nonInteractiveOut,
    stderr: nonInteractiveErr,
    setupRunner: async () => assert.fail("non-interactive setup must not enter prompts"),
  });
  assert.equal(nonInteractiveSetup, 2);
  assert(nonInteractiveErr.value.includes("対話式ターミナルで実行"));
  assert.equal(nonInteractiveOut.value, "");

  await fs.writeFile(configPath, "{}");
  const missingStartOut = captureStream();
  const missingStartErr = captureStream();
  const missingStart = await runCli({
    argv: ["start", "--lang", "en"],
    env: { THRIFTYRELAY_CONFIG_PATH: configPath },
    platform: "win32",
    home: tempRoot,
    stdout: missingStartOut,
    stderr: missingStartErr,
    runtimeStarter: async () => assert.fail("unconfigured runtime must not spawn"),
  });
  assert.equal(missingStart, 1);
  assert(missingStartErr.value.includes("CONFIG_INCOMPLETE"));
  assert.equal(missingStartOut.value, "");

  const pendingRuntimeConfig = path.join(tempRoot, "pending-runtime.json");
  await fs.writeFile(pendingRuntimeConfig, JSON.stringify({
    language: "en",
    workspace,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    tunnelClientPath: tunnelBinary,
  }));
  for (const lifecycleCommand of ["start", "restart"]) {
    const lifecycleOut = captureStream();
    const lifecycleErr = captureStream();
    const lifecycleExit = await runCli({
      argv: [lifecycleCommand, "--lang", "en"],
      env: { THRIFTYRELAY_CONFIG_PATH: pendingRuntimeConfig },
      platform: "win32",
      home: tempRoot,
      stdout: lifecycleOut,
      stderr: lifecycleErr,
      credentialStore: { get: async () => ({ state: "missing" }) },
    });
    assert.equal(lifecycleExit, 1);
    assert(lifecycleErr.value.includes("CREDENTIAL_NOT_CONFIGURED"));
    assert.equal(lifecycleOut.value, "");
    assert(!lifecycleOut.value.includes("Ready"));
  }

  const cancelledStartOut = captureStream();
  const cancelledStartErr = captureStream();
  const cancelledStart = await runCli({
    argv: ["start", "--lang", "en"],
    env: { THRIFTYRELAY_CONFIG_PATH: pendingRuntimeConfig },
    platform: "win32",
    home: tempRoot,
    stdout: cancelledStartOut,
    stderr: cancelledStartErr,
    credentialStore: { get: async () => ({ state: "registered", secret: "fixture" }) },
    runtimeStarter: async () => {
      throw Object.assign(new Error("cancelled"), { code: "RUNTIME_START_CANCELLED", exitCode: 143 });
    },
  });
  assert.equal(cancelledStart, 143, "startup cancellation keeps the shell signal exit code");
  assert.equal(cancelledStartOut.value, "");

  const setupCliOut = captureStream(true);
  const setupCliErr = captureStream();
  const setupCliExit = await runCli({
    argv: ["setup", "--lang", "en"],
    env: { THRIFTYRELAY_CONFIG_PATH: pendingRuntimeConfig },
    platform: "win32",
    home: tempRoot,
    stdin: { isTTY: true },
    stdout: setupCliOut,
    stderr: setupCliErr,
    promptFactory: () => ({ close() {} }),
    setupRunner: async () => ({ ok: false, code: "taskModesPending", message: "pending" }),
    runtimeStarter: async () => assert.fail("incomplete setup must not start a runtime"),
  });
  assert.equal(setupCliExit, 2);
  assert(setupCliErr.value.includes("taskModesPending: pending"));
  assert(!setupCliOut.value.includes("Ready"));

  const readySetupOut = captureStream(true);
  const readySetupErr = captureStream();
  let readyRuntimeStarted = false;
  const readySetupExit = await runCli({
    argv: ["setup", "--lang", "en"],
    env: { THRIFTYRELAY_CONFIG_PATH: pendingRuntimeConfig },
    platform: "win32",
    home: tempRoot,
    stdin: { isTTY: true },
    stdout: readySetupOut,
    stderr: readySetupErr,
    promptFactory: () => ({ close() {} }),
    setupRunner: async options => {
      const runtime = await options.runtimeStarter();
      return { ok: true, language: "en", runtime };
    },
    runtimeStarter: async () => {
      readyRuntimeStarted = true;
      return { waitForExit: async () => ({ exitCode: 0, code: "RUNTIME_STOPPED" }) };
    },
  });
  assert.equal(readySetupExit, 0);
  assert.equal(readyRuntimeStarted, true);
  assert(!readySetupOut.value.includes("Ready. Running in this terminal."));
  assert(readySetupOut.value.includes("Keep this terminal open. Press Ctrl+C to stop."));
  assert(readySetupOut.value.includes("Stopped ThriftyRelay and the tunnel."));
  assert.equal(readySetupErr.value, "");

  const tty = captureStream(true);
  await assert.rejects(withSpinner("Loading", async () => { throw new Error("fixture"); }, { stream: tty, env: {} }));
  assert(tty.value.includes("Loading"));
  assert(tty.value.includes("\u001b[2K"));
  assert(tty.value.includes("\u001b[1G"));
  const ciTty = captureStream(true);
  await withSpinner("Checking", async () => "ok", { stream: ciTty, env: { CI: "1" } });
  assert.equal(ciTty.value, "");

  let backgroundStarts = 0;
  let backgroundStops = 0;
  let posixForegroundStarts = 0;
  const posixConfig = path.join(tempRoot, "posix-runtime.json");
  await fs.writeFile(posixConfig, JSON.stringify({
    language: "en",
    mode: "manual",
    workspace: "/tmp/workspace",
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    tunnelClientPath: "/tmp/tunnel-client",
    taskDirectory: "/tmp/tasks",
    packageRoot: "/tmp/package",
  }));
  const posixEnv = { THRIFTYRELAY_CONFIG_PATH: posixConfig };
  const posixStartOut = captureStream();
  const posixStartErr = captureStream();
  const posixStart = await runCli({
    argv: ["start", "--lang", "en"],
    env: posixEnv,
    platform: "linux",
    home: "/tmp/home",
    stdout: posixStartOut,
    stderr: posixStartErr,
    backgroundStarter: async options => {
      backgroundStarts++;
      assert.equal(options.config.mode, "manual");
      return {};
    },
  });
  assert.equal(posixStart, 0);
  assert.equal(backgroundStarts, 1);
  assert(posixStartOut.value.includes("Started ThriftyRelay and the tunnel in the background."));

  const posixChecks = await collectDoctorChecks({
    platform: "linux",
    home: "/tmp/home",
    env: posixEnv,
    nodeVersion: "v24.0.0",
    resolveInstalledRuntime: async () => ({ sdkResolved: true, nativeBinaryAvailable: true }),
    credentialStore: { backend: "secret-service", has: async () => true },
    probeReadiness: async () => ({ state: "stopped" }),
    policyReader: async () => { throw Object.assign(new Error("POLICY_MISSING"), { code: "POLICY_MISSING" }); },
  });
  assert.equal(posixChecks.find(item => item.id === "config").status, "PASS");
  assert.equal(posixChecks.find(item => item.id === "startup").code, "STARTUP_MANUAL");
  assert.equal(posixChecks.find(item => item.id === "readiness").code, "STOPPED_IDLE");
  assert.equal(posixChecks.find(item => item.id === "policy").code, "POLICY_UNREGISTERED");

  const posixStopOut = captureStream();
  const posixStopErr = captureStream();
  const posixStop = await runCli({
    argv: ["stop", "--lang", "en"],
    env: posixEnv,
    platform: "linux",
    home: "/tmp/home",
    stdout: posixStopOut,
    stderr: posixStopErr,
    backgroundStopper: async () => { backgroundStops++; return { ok: true, stopped: true }; },
  });
  assert.equal(posixStop, 0);
  assert.equal(backgroundStops, 1);
  assert(posixStopOut.value.includes("Stopped ThriftyRelay and the tunnel."));

  const posixForegroundOut = captureStream();
  const posixForegroundErr = captureStream();
  const posixForeground = await runCli({
    argv: ["start", "--foreground", "--lang", "en"],
    env: posixEnv,
    platform: "linux",
    home: "/tmp/home",
    stdout: posixForegroundOut,
    stderr: posixForegroundErr,
    foregroundStarter: async ({ runtimeStarter: starter }) => starter(),
    runtimeStarter: async () => {
      posixForegroundStarts++;
      return { waitForExit: async () => ({ exitCode: 0, code: "RUNTIME_STOPPED" }) };
    },
  });
  assert.equal(posixForeground, 0);
  assert.equal(posixForegroundStarts, 1);
  assert(posixForegroundOut.value.includes("Stopped ThriftyRelay and the tunnel."));

  const winForegroundErr = captureStream();
  const winForeground = await runCli({
    argv: ["start", "--foreground", "--lang", "en"],
    platform: "win32",
    home: tempRoot,
    stdout: captureStream(),
    stderr: winForegroundErr,
  });
  assert.equal(winForeground, 2);
  assert(winForegroundErr.value.includes("supported options"));

  let uninstallOptions;
  const uninstallOut = captureStream(true);
  const uninstallErr = captureStream();
  const uninstallExit = await runCli({
    argv: ["uninstall", "--dry-run", "--lang", "en"],
    env: { THRIFTYRELAY_CONFIG_PATH: configPath },
    platform: "win32",
    home: tempRoot,
    stdout: uninstallOut,
    stderr: uninstallErr,
    credentialStore: { delete: async () => true },
    uninstallRunner: async options => {
      uninstallOptions = options;
      options.stdout.write("uninstall plan\n");
      return 0;
    },
  });
  assert.equal(uninstallExit, 0);
  assert.equal(uninstallOptions.dryRun, true);
  assert.equal(uninstallOptions.yes, false);
  assert.equal(uninstallOptions.configFile, configPath);
  assert.equal(uninstallErr.value, "");
  assert(uninstallOut.value.includes("uninstall plan"));

  let yesSeen = false;
  const yesExit = await runCli({
    argv: ["uninstall", "--yes", "--lang", "en"],
    env: { THRIFTYRELAY_CONFIG_PATH: configPath },
    platform: "win32",
    home: tempRoot,
    stdout: captureStream(),
    stderr: captureStream(),
    uninstallRunner: async options => {
      yesSeen = options.yes;
      return 0;
    },
  });
  assert.equal(yesExit, 0);
  assert.equal(yesSeen, true);

  const invalidUninstall = captureStream();
  const invalidUninstallExit = await runCli({
    argv: ["uninstall", "--json", "--lang", "en"],
    env: { THRIFTYRELAY_CONFIG_PATH: configPath },
    platform: "win32",
    home: tempRoot,
    stdout: captureStream(),
    stderr: invalidUninstall,
    uninstallRunner: async () => assert.fail("invalid arguments must not run uninstall"),
  });
  assert.equal(invalidUninstallExit, 2);
  assert(invalidUninstall.value.includes("supported options"));

  const misplacedYes = captureStream();
  const misplacedYesExit = await runCli({
    argv: ["status", "--yes", "--lang", "en"],
    env: { THRIFTYRELAY_CONFIG_PATH: configPath },
    platform: "win32",
    home: tempRoot,
    stdout: captureStream(),
    stderr: misplacedYes,
    uninstallRunner: async () => assert.fail("--yes is only for uninstall"),
  });
  assert.equal(misplacedYesExit, 2);
  assert(misplacedYes.value.includes("supported options"));

  await runSetupRuntimeTests(path.join(tempRoot, "runtime-fixtures"));

  // Setup must not fold the temporary area into the workspace, the task store, the config
  // directory, or the checkout in either direction.
  const prepRoot = path.join(tempRoot, "prep");
  const prepWorkspace = path.join(prepRoot, "workspace");
  const prepTasks = path.join(prepRoot, "tasks");
  const prepConfig = path.join(prepRoot, "config", "config.json");
  const prepPackage = path.join(prepRoot, "package");
  const prepRuntime = path.join(prepRoot, "state");
  const prepOptions = { platform: process.platform, workspace: prepWorkspace, taskDirectory: prepTasks,
    runtimeDirectory: prepRuntime, configFile: prepConfig, packageRoot: prepPackage };
  assert.deepEqual(await prepareTempWorkspace({ ...prepOptions, value: "relative" }),
    { ok: false, code: "TEMP_ABSOLUTE_REQUIRED" });
  for (const value of [prepWorkspace, path.join(prepWorkspace, "temp"), prepRoot]) {
    assert.equal((await prepareTempWorkspace({ ...prepOptions, value })).code, "TEMP_OVERLAPS_WORKSPACE", value);
  }
  for (const value of [path.join(prepTasks, "temp"), prepTasks]) {
    assert.equal((await prepareTempWorkspace({ ...prepOptions, value })).code, "TEMP_OVERLAPS_TASK_STORE", value);
  }
  for (const value of [path.join(prepRoot, "config", "temp"), path.join(prepRoot, "config")]) {
    assert.equal((await prepareTempWorkspace({ ...prepOptions, value })).code, "TEMP_OVERLAPS_CONFIG", value);
  }
  for (const value of [path.join(prepRuntime, "temp"), prepRuntime]) {
    assert.equal((await prepareTempWorkspace({ ...prepOptions, value })).code, "TEMP_OVERLAPS_RUNTIME_STATE", value);
  }
  for (const value of [path.join(prepPackage, "temp"), prepPackage]) {
    assert.equal((await prepareTempWorkspace({ ...prepOptions, value })).code, "TEMP_INSIDE_PACKAGE", value);
  }
  const prepared = await prepareTempWorkspace({ ...prepOptions, value: path.join(prepRoot, "scratch") });
  assert.equal(prepared.ok, true);
  // A link in an existing ancestor must not disguise a path that really lives inside one of the
  // protected areas: the accepted area would otherwise be created and swept inside it.
  const linkedWorkspace = path.join(prepRoot, "linked-workspace");
  const workspaceAlias = path.join(prepRoot, "alias");
  await fs.mkdir(linkedWorkspace, { recursive: true });
  let aliasLinked = false;
  try {
    await fs.symlink(linkedWorkspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    aliasLinked = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error.code)) throw error;
  }
  if (aliasLinked) {
    assert.equal((await prepareTempWorkspace({
      ...prepOptions, workspace: linkedWorkspace, value: path.join(workspaceAlias, "temp"),
    })).code, "TEMP_OVERLAPS_WORKSPACE");
    assert.equal((await prepareTempWorkspace({
      ...prepOptions, taskDirectory: linkedWorkspace, value: path.join(workspaceAlias, "temp"),
    })).code, "TEMP_OVERLAPS_TASK_STORE");
  }
  // The same separation rules must work with POSIX spelling even when the test host is
  // Windows, because setup is the only place that chooses this path on Linux and macOS.
  const posixOptions = {
    platform: "linux", workspace: "/home/rose/work", taskDirectory: "/home/rose/.local/state/thriftyrelay/tasks",
    runtimeDirectory: "/home/rose/.local/state/thriftyrelay",
    configFile: "/home/rose/.config/ThriftyRelay/config.json", packageRoot: "/home/rose/repo",
    lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    stat: async () => ({ isDirectory: () => true }), mkdir: async () => {},
    realpath: async value => value,
  };
  assert.equal((await prepareTempWorkspace({ ...posixOptions, value: "/home/rose/.cache/thriftyrelay/temp" })).ok, true);
  assert.equal((await prepareTempWorkspace({ ...posixOptions, value: "/home/rose/.config/ThriftyRelay/temp" })).code,
    "TEMP_OVERLAPS_CONFIG");
  // /home/rose/alias is a link to the workspace; the missing tail is resolved on top of it.
  const posixLinkOptions = {
    ...posixOptions,
    realpath: async value => {
      if (value === "/") return "/";
      if (value === "/home/rose/alias") return "/home/rose/work";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
  assert.equal((await prepareTempWorkspace({ ...posixLinkOptions, value: "/home/rose/alias/temp" })).code,
    "TEMP_OVERLAPS_WORKSPACE");

  const tuiConfigPath = path.join(tempRoot, "tui-settings.json");
  await fs.writeFile(tuiConfigPath, "{}");
  const tuiInput = new PassThrough();
  tuiInput.isTTY = true;
  tuiInput.setRawMode = () => {};
  const tuiFrames = [];
  const tuiKeys = ["down", "return", "escape", "q"];
  const tuiOutput = {
    isTTY: true,
    write(chunk) {
      const frame = String(chunk);
      if (frame.includes(translate("ja", "settings.tui.help"))) {
        tuiFrames.push(frame);
        const name = tuiKeys.shift();
        setImmediate(() => tuiInput.emit("keypress", undefined, { name }));
      }
      return true;
    },
  };
  let tuiTimer;
  try {
    const tuiExit = await Promise.race([
      runCli({ argv: ["settings", "--lang", "ja"], platform: "win32", home: tempRoot,
        env: { THRIFTYRELAY_CONFIG_PATH: tuiConfigPath, WT_SESSION: "fixture" },
        stdin: tuiInput, stdout: tuiOutput, stderr: captureStream() }),
      new Promise((_, reject) => { tuiTimer = setTimeout(() => reject(new Error("TUI_DISPLAY_TIMEOUT")), 3000); }),
    ]);
    assert.equal(tuiExit, 0);
    assert.equal(tuiKeys.length, 0);
    assert(!tuiFrames[0].includes("推奨:"));
    assert(!tuiFrames[1].includes("推奨:"));
    for (const frame of [tuiFrames[0], tuiFrames[1], tuiFrames[3]]) {
      assert(!frame.includes(translate("ja", "settings.note.models")));
      assert(!frame.includes(translate("ja", "settings.note.quota")));
    }
    assert(!tuiFrames[2].includes(translate("ja", "settings.note.models")));
    assert(!tuiFrames[2].includes(translate("ja", "settings.note.quota")));
    assert.equal(await fs.readFile(tuiConfigPath, "utf8"), "{}");
  } finally {
    clearTimeout(tuiTimer);
    tuiInput.destroy();
  }

  // Percentages are values, not choice indices. Invalid and empty input must never save.
  const numericInput = new PassThrough();
  numericInput.isTTY = true;
  numericInput.setRawMode = () => {};
  const numericKeys = [
    ...Array.from({ length: 5 }, () => ({ name: "down" })), { name: "return" },
    { name: "u", sequence: "\x15" }, { sequence: "101" }, { name: "return" },
    { name: "u", sequence: "\x15" }, { name: "return" },
    { sequence: "1.5" }, { name: "return" },
    { name: "u", sequence: "\x15" }, { sequence: "100" }, { name: "return" },
    { name: "down" }, { name: "return" },
    { name: "u", sequence: "\x15" }, { sequence: "0" }, { name: "return" },
    { name: "return" }, { name: "u", sequence: "\x15" }, { sequence: "70" },
    { name: "escape" }, { name: "q" },
  ];
  const numericFrames = [];
  let pastedFramesRemaining = 0;
  let numericTimer;
  try {
    const numericExit = await Promise.race([
      runCli({ argv: ["settings", "--lang", "ja"], platform: "win32", home: tempRoot,
        env: { THRIFTYRELAY_CONFIG_PATH: tuiConfigPath, WT_SESSION: "fixture" },
        stdin: numericInput, stderr: captureStream(), stdout: { isTTY: true, write(chunk) {
          const frame = String(chunk);
          if (frame.includes(translate("ja", "settings.tui.help")) || frame.includes(translate("ja", "settings.tui.numberHelp"))) {
            numericFrames.push(frame);
            if (pastedFramesRemaining > 0) { pastedFramesRemaining--; return true; }
            const key = numericKeys.shift();
            assert(key, "numeric TUI should not redraw without input");
            setImmediate(() => {
              if (!key.name) {
                pastedFramesRemaining = key.sequence.length - 1;
                numericInput.write(key.sequence);
              }
              else numericInput.emit("keypress", undefined, key);
            });
          }
          return true;
        } } }),
      new Promise((_, reject) => { numericTimer = setTimeout(() => reject(new Error("NUMERIC_TUI_TIMEOUT")), 3000); }),
    ]);
    assert.equal(numericExit, 0);
    assert.equal(numericKeys.length, 0);
    assert.equal(numericFrames.filter(frame => frame.includes(translate("ja", "settings.ui.percentInvalid"))).length >= 3, true);
    const invalidFrame = numericFrames.findIndex(frame => frame.includes("> 101\n" + translate("ja", "settings.ui.percentInvalid")));
    assert(invalidFrame >= 0, "the validation message belongs directly below the input");
    assert(!numericFrames[invalidFrame + 1].includes(translate("ja", "settings.ui.percentInvalid")), "the next key must clear the message");
    const savedNumeric = await readSetupConfig(tuiConfigPath);
    assert.equal(savedNumeric.fiveHourLimitPercent, 100);
    assert.equal(savedNumeric.weeklyLimitPercent, 0, "Esc must discard the unsaved 70");
    assert(!numericFrames.some(frame => frame.includes("101. 100%")), "percentages must not render a choice list");
  } finally {
    clearTimeout(numericTimer);
    numericInput.destroy();
  }

  // The fallback menu must reach all nine fields and accept the numeric value itself.
  const numberInput = new PassThrough();
  numberInput.isTTY = true;
  const numberAnswers = ["6", "25", "9", "2", "q"];
  const numberOutput = new PassThrough();
  numberOutput.isTTY = true;
  numberOutput.on("data", chunk => {
    if (["settings.tui.numberPrompt", "settings.tui.percentPrompt", "settings.tui.numberOption"].some(key => String(chunk).includes(translate("en", key)))) {
      const answer = numberAnswers.shift();
      assert.notEqual(answer, undefined);
      setImmediate(() => numberInput.write(answer + "\n"));
    }
  });
  let numberTimer;
  try {
    const numberExit = await Promise.race([
      runCli({ argv: ["settings", "--lang", "en"], platform: "win32", home: tempRoot,
        env: { THRIFTYRELAY_CONFIG_PATH: tuiConfigPath }, stdin: numberInput,
        stderr: captureStream(), stdout: numberOutput }),
      new Promise((_, reject) => { numberTimer = setTimeout(() => reject(new Error("NUMBER_MENU_TIMEOUT")), 3000); }),
    ]);
    assert.equal(numberExit, 0);
    assert.equal(numberAnswers.length, 0);
    const savedNumber = await readSetupConfig(tuiConfigPath);
    assert.equal(savedNumber.fiveHourLimitPercent, 25);
    assert.equal(savedNumber.weeklyLimitAction, "block");
  } finally {
    clearTimeout(numberTimer);
    numberInput.destroy();
    numberOutput.destroy();
  }

  const jsonByLanguage = [];
  for (const displayLanguage of ["ja", "en"]) {
    const output = captureStream();
    assert.equal(await runCli({ argv: ["settings", "show", "--json", "--lang", displayLanguage],
      env: { THRIFTYRELAY_CONFIG_PATH: tuiConfigPath }, stdout: output, stderr: captureStream() }), 0);
    jsonByLanguage.push(JSON.parse(output.value));
  }
  assert.deepEqual(jsonByLanguage[0], jsonByLanguage[1], "display language must not alter CLI JSON");
  assert.deepEqual(jsonByLanguage[0].options.fiveHourLimitPercent, { min: 0, max: 100, step: 1 });
  assert.deepEqual(jsonByLanguage[0].options.weeklyLimitPercent, { min: 0, max: 100, step: 1 });
  assert.equal(Object.hasOwn(jsonByLanguage[0], "labels"), false);

  console.log("CLI CHECKS OK (setup foreground and task install, read-only doctor/status, safe JSON, mocked Task Scheduler, loopback probe, spinner cleanup, POSIX background routing, uninstall routing, focused TUI notes)");
} finally {
  process.chdir(originalCwd);
  await fs.rm(setupCwd, { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}
