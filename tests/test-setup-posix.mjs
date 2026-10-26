import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../src/cli/setup.mjs";
import { readSetupConfig } from "../src/config.mjs";

const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";

if (process.platform !== "linux") {
  console.log("SKIP: POSIX setup runs on Linux");
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.homedir(), ".thriftyrelay-setup-test-"));
const workspace = path.join(root, "workspace");
const tunnelFile = path.join(root, "tunnel-client");
await fs.mkdir(workspace, { mode: 0o700 });
await fs.writeFile(tunnelFile, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
await fs.chmod(tunnelFile, 0o700);

function promptsFor(answers) {
  const queue = [...answers];
  return {
    language: async () => "en",
    text: async () => queue.shift() ?? "",
    yesNo: async () => true,
    secret: async () => "fixture-runtime-key",
    write: () => {},
    close: () => {},
  };
}

try {
  const configDir = path.join(root, ".config", "ThriftyRelay");
  await fs.mkdir(configDir, { recursive: true });
  const configFile = path.join(configDir, "config.json");
  const stored = [];
  const setup = await runSetup({
    configFile,
    initialLanguage: "en",
    platform: "linux",
    home: root,
    cwd: workspace,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: promptsFor([workspace, TUNNEL_ID, ""]),
    credentialStore: {
      has: async () => false,
      set: async value => { stored.push(value); },
    },
    env: {},
    tunnelResolver: async () => tunnelFile,
    fileExists: async value => fs.stat(value).then(stat => stat.isFile(), () => false),
    directoryExists: async value => fs.stat(value).then(stat => stat.isDirectory(), () => false),
  });
  assert.equal(setup.ok, true);
  assert.equal(setup.saved, true);
  assert.equal(setup.ready, false);
  assert.equal(setup.config.mode, "manual");
  assert.equal(setup.config.taskDirectory, path.join(root, ".local", "state", "thriftyrelay", "tasks"));
  assert.equal(setup.tempWorkspace, path.join(root, ".cache", "thriftyrelay", "temp"));
  assert.match(setup.message, /`thriftyrelay register-policy --file <policy\.json>`/);
  assert.deepEqual(stored, ["fixture-runtime-key"]);
  const saved = await readSetupConfig(configFile, { platform: "linux" });
  assert.equal(saved.mode, "manual");
  assert.equal(saved.taskDirectory, path.join(root, ".local", "state", "thriftyrelay", "tasks"));
  assert.equal(saved.tempWorkspace, setup.tempWorkspace);
  assert.equal(await fs.stat(saved.tempWorkspace).then(stat => stat.isDirectory(), () => false), true);

  const warningDir = path.join(root, "warning-config");
  await fs.mkdir(warningDir, { recursive: true });
  const warningConfig = path.join(warningDir, "config.json");
  const warning = await runSetup({
    configFile: warningConfig,
    initialLanguage: "en",
    platform: "linux",
    home: root,
    cwd: workspace,
    packageRoot: path.resolve(import.meta.dirname, ".."),
    prompts: promptsFor([workspace, TUNNEL_ID, ""]),
    credentialStore: {
      has: async () => { throw Object.assign(new Error("unavailable"), { code: "CREDENTIAL_BACKEND_UNAVAILABLE" }); },
      set: async () => assert.fail("must not try to write without a backend"),
    },
    env: {},
    tunnelResolver: async () => tunnelFile,
    fileExists: async value => fs.stat(value).then(stat => stat.isFile(), () => false),
    directoryExists: async value => fs.stat(value).then(stat => stat.isDirectory(), () => false),
  });
  assert.equal(warning.ok, true);
  assert.equal(warning.saved, true);
  assert.equal(warning.ready, false);
  assert.equal(warning.credentialError, "CREDENTIAL_BACKEND_UNAVAILABLE");
  assert.equal((await readSetupConfig(warningConfig, { platform: "linux" })).mode, "manual");

  const invalidMode = path.join(root, "invalid-mode.json");
  await fs.writeFile(invalidMode, JSON.stringify({ mode: "foreground", workspace }));
  await assert.rejects(readSetupConfig(invalidMode, { platform: "linux" }), { code: "CONFIG_MODE_INVALID" });
  console.log("POSIX SETUP CHECKS OK (manual mode, taskDirectory, deferred credential warning)");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
