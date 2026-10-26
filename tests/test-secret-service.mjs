import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createCredentialStore } from "../src/platform/linux/secrets.mjs";
import { runSecretCommand } from "../src/platform/posix/secrets.mjs";

// End-to-end check of the Linux secret backend against a real Secret Service. The parent
// run isolates both the session bus and the keyring so a developer's stored key can never
// be read, overwritten or cleared by this test.
const CHILD_MARKER = "THRIFTYRELAY_SECRET_SERVICE_CHILD";
const ATTRIBUTES = ["service", "ThriftyRelay", "key", "CONTROL_PLANE_API_KEY"];
const PROBE_ATTRIBUTES = ["service", "ThriftyRelayTest", "key", "readiness"];

if (process.platform !== "linux") {
  console.log("SKIP secret service integration (Linux only)");
  process.exit(0);
}

if (process.env[CHILD_MARKER] !== "1") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "thrifty-relay-secrets-"));
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    [CHILD_MARKER]: "1",
  };
  fs.mkdirSync(env.XDG_DATA_HOME, { recursive: true });
  const result = spawnSync("dbus-run-session", ["--", process.execPath, fileURLToPath(import.meta.url)],
    { stdio: "inherit", env });
  fs.rmSync(home, { recursive: true, force: true });
  if (result.error) {
    console.error("SECRET SERVICE UNAVAILABLE: " + (result.error.code || result.error.message));
    process.exit(2);
  }
  process.exit(result.status ?? 1);
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function startKeyring() {
  const daemon = spawn("gnome-keyring-daemon", ["--unlock", "--components=secrets", "--daemonize"],
    { stdio: ["pipe", "ignore", "ignore"] });
  await new Promise((resolve, reject) => {
    daemon.once("error", reject);
    daemon.once("close", resolve);
    daemon.stdin.end("thrifty-relay-test");
  });
}

// A missing item and an unreachable service both exit 1 without stderr, so readiness is
// probed by writing a throwaway item instead of by looking one up.
async function waitForService() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await runSecretCommand("secret-tool",
      ["store", "--label=ThriftyRelay test probe", ...PROBE_ATTRIBUTES], "probe");
    if (result.code === 0) {
      await runSecretCommand("secret-tool", ["clear", ...PROBE_ATTRIBUTES]);
      return;
    }
    await sleep(200);
  }
  throw new Error("SECRET_SERVICE_NOT_READY");
}

await startKeyring();
await waitForService();

const calls = [];
const store = createCredentialStore({
  platform: "linux",
  run: (command, args, input) => {
    calls.push({ command, args: [...args], input });
    return runSecretCommand(command, args, input);
  },
});

try {
  assert.equal(await store.has(), false, "an isolated keyring starts empty");
  const secret = "integration-" + "x".repeat(48);
  assert.equal(await store.set(secret), true);
  assert.deepEqual(await store.get(), { state: "registered", secret });
  assert.equal(await store.has(), true);

  const write = calls.find(call => call.args[0] === "store");
  assert.equal(write.command, "secret-tool");
  assert.equal(write.args.some(argument => argument.includes(secret)), false, "the secret must not be in argv");
  assert.equal(write.input, secret, "the secret must travel over stdin");

  await assert.rejects(store.set(""), error => error.code === "CREDENTIAL_INPUT_INVALID");
  await assert.rejects(store.set("a\0b"), error => error.code === "CREDENTIAL_INPUT_INVALID");

  const pathBefore = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const missing = createCredentialStore({ platform: "linux" });
    await assert.rejects(missing.has(), error => error.code === "CREDENTIAL_BACKEND_UNAVAILABLE");
  } finally {
    process.env.PATH = pathBefore;
  }

  console.log("SECRET SERVICE OK");
} finally {
  await runSecretCommand("secret-tool", ["clear", ...ATTRIBUTES]).catch(() => {});
}
