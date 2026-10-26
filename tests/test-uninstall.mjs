import assert from "node:assert/strict";
import {
  executeUninstall,
  planUninstall,
  runUninstallCommand,
} from "../src/cli/uninstall.mjs";

// Uninstall is the one command that removes credentials and configuration. The tests drive the
// plan and the execution separately so the read-only preview cannot accidentally gain a side
// effect, and every failure path that matters checks what was deliberately left in place.

function capture() {
  let value = "";
  return {
    isTTY: true,
    write(chunk) { value += String(chunk); return true; },
    get value() { return value; },
  };
}

function fakeFilesystem(files = [], directories = []) {
  const fileSet = new Set(files);
  const directorySet = new Set(directories);
  const calls = [];
  return {
    calls,
    fileSet,
    directorySet,
    async unlink(file) {
      calls.push(["unlink", file]);
      if (!fileSet.delete(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async rmdir(directory) {
      calls.push(["rmdir", directory]);
      if (!directorySet.has(directory)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const separator = directory.includes("\\") ? "\\" : "/";
      const prefix = directory.endsWith(separator) ? directory : `${directory}${separator}`;
      const nestedFile = [...fileSet].some(file => file.startsWith(prefix));
      const nestedDirectory = [...directorySet].some(value => value !== directory && value.startsWith(prefix));
      if (nestedFile || nestedDirectory) throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
      directorySet.delete(directory);
    },
  };
}

const win = {
  platform: "win32",
  env: {
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
  },
  home: "C:\\Users\\fixture",
  configFile: "C:\\Users\\fixture\\AppData\\Roaming\\ThriftyRelay\\config.json",
  config: {
    mode: "on-login-task",
    workspace: "C:\\work",
    tunnelClientPath: "C:\\tools\\tunnel-client.exe",
    taskDirectory: "C:\\records\\tasks",
  },
};
const winLauncher = "C:\\Users\\fixture\\AppData\\Local\\ThriftyRelay\\Start-ThriftyRelay.ps1";
const winLog = "C:\\Users\\fixture\\AppData\\Local\\ThriftyRelay\\logs\\remote.log";

// The plan names the exact locations the setup path wrote and repeats the two preserved
// locations. Reading it must not stop, remove, or delete anything.
const winPlan = await planUninstall({ ...win, configReader: async () => win.config });
assert.equal(winPlan.launcher, winLauncher);
assert.equal(winPlan.launcherLog, winLog);
assert.equal(winPlan.configDirectory, "C:\\Users\\fixture\\AppData\\Roaming\\ThriftyRelay");
assert.equal(winPlan.taskStore, "C:\\records\\tasks");
assert.equal(winPlan.stateDirectory, null);

let winStarts = 0;
const winFiles = fakeFilesystem(
  [win.configFile, winLauncher, winLog],
  [
    "C:\\Users\\fixture\\AppData\\Local\\ThriftyRelay\\logs",
    "C:\\Users\\fixture\\AppData\\Local\\ThriftyRelay",
    "C:\\Users\\fixture\\AppData\\Roaming\\ThriftyRelay",
  ],
);
const winReadTasks = async () => [
  { name: "ThriftyRelay MCP", state: "Running" },
];
const winResult = await executeUninstall(winPlan, {
  language: "en",
  taskReader: winReadTasks,
  taskStopper: async options => {
    winStarts++;
    assert.equal(options.config.tunnelClientPath, "C:\\tools\\tunnel-client.exe");
    return { ok: true };
  },
  taskRemover: async options => {
    assert.equal(options.name, "ThriftyRelay MCP");
    return { ok: true, name: options.name, removed: true };
  },
  probeReadiness: async () => ({ state: "stopped" }),
  credentialStore: { delete: async () => { winFiles.calls.push(["deleteCredential"]); return true; } },
  unlink: winFiles.unlink,
  rmdir: winFiles.rmdir,
});
assert.equal(winResult.ok, true, winResult.code);
assert.equal(winStarts, 1);
assert.equal(winFiles.fileSet.has(win.configFile), false);
// Product files are removed while the task store and unrelated data remain.
assert.equal(winFiles.fileSet.has(winLauncher), false);
assert.equal(winFiles.fileSet.has(winLog), false);
assert.equal(winResult.actions.find(item => item.id === "launcher").status, "removed");
assert.equal(winResult.actions.find(item => item.id === "logs").status, "removed");
assert.deepEqual(winResult.preserved.map(item => item.id), ["taskStore", "codexAuth", "policy"]);
assert.equal(winResult.preserved[0].path, "C:\\records\\tasks");

// An idle task must not send the stop path after a different installation's tunnel.
let idleStops = 0;
const idleWithListener = await executeUninstall(winPlan, {
  taskReader: async () => [{ name: "ThriftyRelay MCP", state: "Ready" }],
  taskStopper: async () => { idleStops++; return { ok: true }; },
  probeReadiness: async () => ({ state: "responding" }),
  credentialStore: { delete: async () => assert.fail("an unverified runtime must not lose its credential") },
  unlink: async () => assert.fail("an unverified runtime must not lose its files"),
  rmdir: async () => assert.fail("an unverified runtime must not lose its directories"),
});
assert.equal(idleWithListener.ok, false);
assert.equal(idleWithListener.code, "UNINSTALL_RUNTIME_STOP_UNCONFIRMED");
assert.equal(idleStops, 0);

// An already-idle task with a free endpoint can be removed without entering the stop path.
let idleRemoved = 0;
const idleReady = await executeUninstall(winPlan, {
  taskReader: async () => [{ name: "ThriftyRelay MCP", state: "Ready" }],
  taskStopper: async () => assert.fail("an idle task must not enter the owner-killing path"),
  taskRemover: async () => { idleRemoved++; return { ok: true, removed: true }; },
  probeReadiness: async () => ({ state: "stopped" }),
  credentialStore: { delete: async () => true },
  unlink: async () => {},
  rmdir: async () => {},
});
assert.equal(idleReady.ok, true, idleReady.code);
assert.equal(idleRemoved, 1);

// A failed stop is the point of no return for this command: the credential and files must
// still exist so the operator can retry after resolving the runtime.
let credentialDeletes = 0;
const stopFailure = await executeUninstall(winPlan, {
  taskReader: async () => { throw Object.assign(new Error("query"), { code: "STARTUP_QUERY_FAILED" }); },
  credentialStore: { delete: async () => { credentialDeletes++; return true; } },
  unlink: async () => assert.fail("a failed stop must not remove files"),
  rmdir: async () => assert.fail("a failed stop must not remove directories"),
});
assert.equal(stopFailure.ok, false);
assert.equal(stopFailure.code, "UNINSTALL_TASK_QUERY_FAILED");
assert.equal(stopFailure.detailCode, "STARTUP_QUERY_FAILED");
assert.equal(credentialDeletes, 0);
assert.equal(stopFailure.actions[0].status, "failed");

// A credential failure after the task is stopped must not leave the user with a half-removed
// configuration that no longer has a matching task. The files are kept so the command can be
// retried once the backend is available.
const credentialFailure = await executeUninstall(winPlan, {
  taskReader: async () => [],
  probeReadiness: async () => ({ state: "stopped" }),
  credentialStore: { delete: async () => { throw Object.assign(new Error("backend"), { code: "CREDENTIAL_BACKEND_ERROR" }); } },
  unlink: async () => assert.fail("a failed credential deletion must not remove files"),
  rmdir: async () => assert.fail("a failed credential deletion must not remove directories"),
});
assert.equal(credentialFailure.ok, false);
assert.equal(credentialFailure.code, "UNINSTALL_CREDENTIAL_DELETE_FAILED");
assert.equal(credentialFailure.actions.find(action => action.id === "credentials").status, "failed");

const foregroundPlan = {
  ...winPlan,
  config: { ...win.config, mode: "foreground" },
};
const foreground = await executeUninstall(foregroundPlan, {
  taskReader: async () => [],
  probeReadiness: async () => ({ state: "responding" }),
  credentialStore: { delete: async () => assert.fail("a responding foreground runtime must block uninstall") },
  unlink: async () => assert.fail("a responding foreground runtime must not remove files"),
  rmdir: async () => assert.fail("a responding foreground runtime must not remove directories"),
});
assert.equal(foreground.ok, false);
assert.equal(foreground.code, "UNINSTALL_FOREGROUND_RUNNING");

// POSIX has no task. The background stopper receives the recorded state file, the runtime
// directory is cleaned, and the task store is never touched.
const posix = {
  platform: "linux",
  env: { XDG_CONFIG_HOME: "/home/fixture/.config", XDG_STATE_HOME: "/home/fixture/.local/state" },
  home: "/home/fixture",
  configFile: "/home/fixture/.config/ThriftyRelay/config.json",
  config: {
    mode: "manual",
    workspace: "/home/fixture/work",
    taskDirectory: "/home/fixture/.local/state/thriftyrelay/tasks",
  },
};
const posixPlan = await planUninstall({ ...posix, configReader: async () => posix.config });
assert.equal(posixPlan.configDirectory, "/home/fixture/.config/ThriftyRelay");
assert.equal(posixPlan.stateDirectory, "/home/fixture/.local/state/thriftyrelay");
assert.equal(posixPlan.stateFile, "/home/fixture/.local/state/thriftyrelay/runtime.json");
const posixFiles = fakeFilesystem(
  [
    posix.configFile,
    "/home/fixture/.local/state/thriftyrelay/runtime.json",
    "/home/fixture/.local/state/thriftyrelay/runtime.log",
    "/home/fixture/.local/state/thriftyrelay/tasks/active.lock",
  ],
  [
    "/home/fixture/.config/ThriftyRelay",
    "/home/fixture/.local/state/thriftyrelay",
    "/home/fixture/.local/state/thriftyrelay/tasks",
  ],
);
let stoppedStateFile;
const posixResult = await executeUninstall(posixPlan, {
  backgroundStopper: async options => { stoppedStateFile = options.stateFile; return { ok: true, stopped: true }; },
  credentialStore: { delete: async () => true },
  unlink: posixFiles.unlink,
  rmdir: posixFiles.rmdir,
});
assert.equal(posixResult.ok, true, posixResult.code);
assert.equal(stoppedStateFile, posixPlan.stateFile);
assert.equal(posixFiles.fileSet.has(posix.configFile), false);
assert.equal(posixFiles.fileSet.has("/home/fixture/.local/state/thriftyrelay/runtime.json"), false);
assert.equal(posixFiles.directorySet.has("/home/fixture/.local/state/thriftyrelay"), true, "the parent remains while it contains task records");
assert.equal(posixFiles.directorySet.has("/home/fixture/.config/ThriftyRelay"), false);
assert.equal(posixFiles.fileSet.has("/home/fixture/.local/state/thriftyrelay/tasks/active.lock"), true, "task records are preserved");
assert.equal(posixResult.actions.find(item => item.id === "state").status, "kept");

// A supervisor can replace itself while stopping. The replacement owns the state and key, so
// the uninstall must stop before deleting either.
const replacedRuntime = await executeUninstall(posixPlan, {
  backgroundStopper: async () => ({ ok: true, stopped: true, record: "replaced" }),
  credentialStore: { delete: async () => assert.fail("a replacement runtime must keep its credential") },
  unlink: async () => assert.fail("a replacement runtime must keep its state"),
  rmdir: async () => assert.fail("a replacement runtime must keep its directories"),
});
assert.equal(replacedRuntime.ok, false);
assert.equal(replacedRuntime.code, "UNINSTALL_RUNTIME_REPLACED");

// A dry run prints the same plan but must not call any destructive dependency.
const dryOut = capture();
let drySideEffects = 0;
const dryExit = await runUninstallCommand({
  ...win,
  language: "en",
  yes: true,
  dryRun: true,
  stdout: dryOut,
  stderr: capture(),
  planOptions: { configReader: async () => win.config },
  executeOptions: {
    taskReader: async () => { drySideEffects++; return []; },
    credentialStore: { delete: async () => { drySideEffects++; return true; } },
  },
});
assert.equal(dryExit, 0);
assert.equal(drySideEffects, 0);
assert(dryOut.value.includes("Keep:\n- Task store:"));
assert(dryOut.value.includes("Task store"));
assert(!dryOut.value.includes("Uninstall completed"));

// Non-interactive execution without --yes must refuse before any dependency runs.
const refused = capture();
const refusedErr = capture();
const refusedExit = await runUninstallCommand({
  ...win,
  language: "en",
  stdout: refused,
  stderr: refusedErr,
  stdin: { isTTY: false },
  planOptions: { configReader: async () => win.config },
  executeOptions: {
    taskReader: async () => assert.fail("confirmation must happen before execution"),
  },
});
assert.equal(refusedExit, 2);
assert(refusedErr.value.includes("--yes"));

const failedOut = capture();
const failedErr = capture();
assert.equal(await runUninstallCommand({
  ...win, language: "ja", yes: true, stdout: failedOut, stderr: failedErr,
  planOptions: { configReader: async () => win.config },
  executeOptions: {
    taskReader: async () => { throw Object.assign(new Error(), { code: "STARTUP_QUERY_FAILED" }); },
    credentialStore: { delete: async () => assert.fail("query failure must stop before deletion") },
  },
}), 1);
assert(failedOut.value.includes("ThriftyRelayの停止: 失敗しました (STARTUP_QUERY_FAILED)"));
assert.equal(failedErr.value, "Windowsタスクの状態を読み取れませんでした。\nアンインストールを中止しました。何も削除していません。\n");

console.log("UNINSTALL CHECKS OK (Windows and POSIX plans, stop-first ordering, credential deletion, preserved task store, dry run, confirmation)");
