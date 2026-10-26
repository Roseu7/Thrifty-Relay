import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCredentialStore } from "../src/platform/index.mjs";

// The runtime key store is the one adapter whose mistakes are not recoverable by a later
// fix: a wrong answer either hides a key that exists or hands out one that does not. The
// assertions below therefore pin the exact backend invocation, including the two
// properties that keep the value out of places other processes can read.

const checks = [];

// An OS without a backend must fail rather than guess at a store.
assert.throws(() => createCredentialStore({ platform: "aix", env: {} }), { code: "REMOTE_PLATFORM_UNSUPPORTED" });
checks.push("unsupported-platform-fails-loudly");

const LINUX_LOOKUP = ["lookup", "service", "ThriftyRelay", "key", "CONTROL_PLANE_API_KEY"];
const LINUX_STORE = ["store", "--label=ThriftyRelay control plane key", "service", "ThriftyRelay", "key", "CONTROL_PLANE_API_KEY"];

// A registered item is read through secret-tool and one trailing newline is stripped;
// the key itself may contain any other character.
const linuxRead = createCredentialStore({
  platform: "linux",
  env: {},
  run: async (command, args) => {
    assert.equal(command, "secret-tool");
    assert.deepEqual(args, LINUX_LOOKUP);
    return { code: 0, stdout: "value with spaces & $pecial\n", stderr: "" };
  },
});
assert.deepEqual(await linuxRead.get(), { state: "registered", secret: "value with spaces & $pecial" });
assert.equal(await linuxRead.has(), true);
assert.equal(linuxRead.backend, "secret-service");
checks.push("linux-read");

// "the item is absent" and "the backend is broken" both end in a non zero exit status, so
// they are separated by the diagnostics: only a silent exit 1 means the key is missing.
const DBUS = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/fixture-bus" };
const linuxMissing = createCredentialStore({ platform: "linux", env: DBUS, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
assert.deepEqual(await linuxMissing.get(), { state: "missing" });
assert.equal(await linuxMissing.has(), false);
// A silent exit 1 without a session bus is an unreachable store, not an absent item.
const linuxNoBus = createCredentialStore({ platform: "linux", env: {}, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
await assert.rejects(linuxNoBus.has(), { code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
await assert.rejects(linuxNoBus.set("value"), { code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
const linuxBroken = createCredentialStore({
  platform: "linux",
  env: {},
  run: async () => ({ code: 1, stdout: "", stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" }),
});
await assert.rejects(linuxBroken.get(), { code: "CREDENTIAL_BACKEND_ERROR" });
await assert.rejects(linuxBroken.has(), { code: "CREDENTIAL_BACKEND_ERROR" });
// A host with no Secret Service at all is reported as unavailable, not as "no key", so
// the operator is told to supply the key another way instead of setting it again.
const linuxAbsent = createCredentialStore({
  platform: "linux",
  env: {},
  run: async () => { throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" }); },
});
await assert.rejects(linuxAbsent.has(), { code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
await assert.rejects(linuxAbsent.set("value"), { code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
checks.push("linux-missing-and-unavailable");

// The secret is handed over on stdin. Putting it in the argument list would expose it to
// every other process of the same user for the duration of the write.
let linuxWrite;
const linuxStore = createCredentialStore({
  platform: "linux",
  env: DBUS,
  run: async (command, args, input) => {
    linuxWrite = { command, args, input };
    return { code: 0, stdout: "", stderr: "" };
  },
});
assert.equal(await linuxStore.set("value with spaces & $pecial"), true);
assert.equal(linuxWrite.command, "secret-tool");
assert.deepEqual(linuxWrite.args, LINUX_STORE);
assert.equal(linuxWrite.input, "value with spaces & $pecial");
assert(!linuxWrite.args.join(" ").includes("value"), "the secret must not appear in the argument list");
checks.push("linux-secret-not-in-argv");

// Uninstall removes the same item the setup path wrote. A silent exit 1 means it was already
// absent, while the same answer without a session bus is an unavailable backend.
let linuxClear;
const linuxDelete = createCredentialStore({
  platform: "linux",
  env: DBUS,
  run: async (command, args) => {
    if (args[0] === "clear") {
      linuxClear = { command, args };
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  },
});
assert.equal(await linuxDelete.delete(), true);
assert.equal(linuxClear.command, "secret-tool");
assert.deepEqual(linuxClear.args, ["clear", "service", "ThriftyRelay", "key", "CONTROL_PLANE_API_KEY"]);
const linuxDeleteMissing = createCredentialStore({
  platform: "linux",
  env: DBUS,
  run: async () => ({ code: 1, stdout: "", stderr: "" }),
});
assert.equal(await linuxDeleteMissing.delete(), false);
// `clear` can succeed while a locked item remains visible. Reporting that as removed would
// leave a usable secret behind after the user thinks it is gone.
const linuxDeleteLocked = createCredentialStore({
  platform: "linux",
  env: DBUS,
  run: async (command, args) => args[0] === "clear"
    ? { code: 0, stdout: "", stderr: "" }
    : { code: 0, stdout: "still-registered\n", stderr: "" },
});
await assert.rejects(linuxDeleteLocked.delete(), { code: "CREDENTIAL_DELETE_FAILED" });
const linuxDeleteNoBus = createCredentialStore({
  platform: "linux",
  env: {},
  run: async () => ({ code: 1, stdout: "", stderr: "" }),
});
await assert.rejects(linuxDeleteNoBus.delete(), { code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
checks.push("linux-delete");

// Reading a secret and asking whether one exists are different operations: the existence
// check must not request the value at all.
const darwinExists = createCredentialStore({
  platform: "darwin",
  env: {},
  run: async (command, args) => {
    assert.equal(command, "/usr/bin/security");
    assert.deepEqual(args, ["find-generic-password", "-s", "ThriftyRelay/CONTROL_PLANE_API_KEY", "-a", "ThriftyRelay"]);
    return { code: 0, stdout: "keychain: ...\nattributes: ...\n", stderr: "" };
  },
});
assert.equal(await darwinExists.has(), true);
assert.equal(darwinExists.backend, "macos-keychain");
checks.push("darwin-exists-does-not-read");

// security reports a missing item through errSecItemNotFound, whose low byte is exit 44.
const darwinMissing = createCredentialStore({
  platform: "darwin",
  env: {},
  run: async () => ({
    code: 44,
    stdout: "",
    stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
  }),
});
assert.deepEqual(await darwinMissing.get(), { state: "missing" });
assert.equal(await darwinMissing.has(), false);
// A locked keychain fails with a different status; that must not be reported as "no key".
const darwinLocked = createCredentialStore({
  platform: "darwin",
  env: {},
  run: async () => ({ code: 1, stdout: "", stderr: "security: User interaction is not allowed." }),
});
await assert.rejects(darwinLocked.get(), { code: "CREDENTIAL_BACKEND_ERROR" });
// A missing keychain is an environment failure, not proof that this item is absent.
const darwinMissingKeychain = createCredentialStore({
  platform: "darwin",
  env: {},
  run: async () => ({
    code: 1,
    stdout: "",
    stderr: "security: The specified keychain could not be found.",
  }),
});
await assert.rejects(darwinMissingKeychain.delete(), { code: "CREDENTIAL_BACKEND_ERROR" });
checks.push("darwin-missing-and-error");

// The item is written with -U so a second setup run updates it instead of failing, and
// without -A so the default access control list is kept.
let darwinWrite;
const darwinStore = createCredentialStore({
  platform: "darwin",
  env: {},
  run: async (command, args) => {
    darwinWrite = { command, args };
    return { code: 0, stdout: "", stderr: "" };
  },
});
assert.equal(await darwinStore.set("key-material"), true);
assert.equal(darwinWrite.command, "/usr/bin/security");
assert.deepEqual(darwinWrite.args, [
  "add-generic-password", "-U", "-s", "ThriftyRelay/CONTROL_PLANE_API_KEY", "-a", "ThriftyRelay", "-w", "key-material",
]);
assert(!darwinWrite.args.includes("-A"), "-A would let any application read the item without asking");
const darwinRead = createCredentialStore({
  platform: "darwin",
  env: {},
  run: async (command, args) => {
    assert.deepEqual(args, ["find-generic-password", "-w", "-s", "ThriftyRelay/CONTROL_PLANE_API_KEY", "-a", "ThriftyRelay"]);
    return { code: 0, stdout: "key-material\n", stderr: "" };
  },
});
assert.deepEqual(await darwinRead.get(), { state: "registered", secret: "key-material" });
let darwinDeleteArgs;
const darwinDelete = createCredentialStore({
  platform: "darwin",
  env: {},
  run: async (command, args) => {
    darwinDeleteArgs = { command, args };
    return { code: 0, stdout: "", stderr: "" };
  },
});
assert.equal(await darwinDelete.delete(), true);
assert.equal(darwinDeleteArgs.command, "/usr/bin/security");
assert.deepEqual(darwinDeleteArgs.args,
  ["delete-generic-password", "-s", "ThriftyRelay/CONTROL_PLANE_API_KEY", "-a", "ThriftyRelay"]);
const darwinDeleteMissing = createCredentialStore({
  platform: "darwin",
  env: {},
  run: async () => ({ code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." }),
});
assert.equal(await darwinDeleteMissing.delete(), false);
checks.push("darwin-write-and-delete");

// Both POSIX backends reject input they cannot store before reaching the backend.
for (const platform of ["linux", "darwin"]) {
  const store = createCredentialStore({
    platform,
    env: {},
    run: async () => { throw new Error("validation must happen before the backend runs"); },
  });
  for (const value of ["", null, undefined, "before\u0000after"]) {
    await assert.rejects(store.set(value), { code: "CREDENTIAL_INPUT_INVALID" });
  }
}
checks.push("invalid-input");

// The environment override exists for hosts with no usable store. It answers for the
// host without consulting the platform store at all, and it is never written back: a
// value passed for one process must not become a permanent registration.
let overrideBackendCalls = 0;
const overridden = createCredentialStore({
  platform: "linux",
  env: { ...DBUS, THRIFTYRELAY_RUNTIME_KEY: "from-environment" },
  run: async () => { overrideBackendCalls++; return { code: 0, stdout: "", stderr: "" }; },
});
assert.deepEqual(await overridden.get(), { state: "registered", secret: "from-environment" });
assert.equal(await overridden.has(), true);
assert.equal(overridden.backend, "environment");
assert.equal(overrideBackendCalls, 0, "the override answers without touching the platform store");
assert.equal(await overridden.set("explicit"), true, "an explicit set still targets the platform store");
assert.equal(overrideBackendCalls, 1);
checks.push("environment-override");

// The same store without the override must report the platform backend, so diagnostics
// never name a source that holds nothing.
const plain = createCredentialStore({ platform: "linux", env: DBUS, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
assert.equal(plain.backend, "secret-service");
checks.push("backend-name-follows-source");

// Windows deletion is a native CredDelete and reports a missing item as a successful no-op.
const windowsCalls = [];
const windowsDelete = createCredentialStore({
  platform: "win32",
  env: {},
  run: async (script, input) => {
    assert(script.includes("CredDeleteW"));
    const payload = JSON.parse(input);
    windowsCalls.push(payload);
    return JSON.stringify({ ok: true, removed: payload.target === "ThriftyRelay/CONTROL_PLANE_API_KEY" });
  },
});
assert.equal(await windowsDelete.delete(), true);
assert.deepEqual(windowsCalls[0], { operation: "delete", target: "ThriftyRelay/CONTROL_PLANE_API_KEY" });

checks.push("windows-delete");

// macOS is the only system where CI can exercise the real store: the Linux runners have
// no session bus. The item name is unique to this test and deleted afterwards, so a
// developer's own keychain entry is never touched.
if (process.platform === "darwin" && process.env.THRIFTYRELAY_KEYCHAIN_TEST !== "skip") {
  const service = "ThriftyRelay/test/nonexistent";
  const account = "thriftyrelay-test";
  const live = createCredentialStore({ platform: "darwin", env: {}, service, account });
  try {
    assert.deepEqual(await live.get(), { state: "missing" }, "a fresh item name must not exist yet");
    // A token-shaped value: the tool cannot round trip anything the keychain reader would
    // report in another form, and the store refuses those instead of distorting them.
    const token = "live-round-trip-token-92517";
    assert.equal(await live.set(token), true);
    assert.equal(await live.has(), true);
    assert.deepEqual(await live.get(), { state: "registered", secret: token });
    await assert.rejects(live.set("line\nbreak"), { code: "CREDENTIAL_INPUT_INVALID" }, "an unsupported value is refused before it is stored");
    execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "ignore" });
    assert.deepEqual(await live.get(), { state: "missing" }, "a deleted item must be reported as missing");
    checks.push("darwin-live-round-trip");
  } catch (error) {
    try { execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "ignore" }); } catch { /* the item may not exist */ }
    throw error;
  }
}

console.log("PASS: " + checks.join(", "));
