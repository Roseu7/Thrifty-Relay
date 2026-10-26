import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launcherAdapter, taskAdapter } from "../src/platform/index.mjs";
import { launcherPath, launcherScript } from "../src/platform/win32/launcher.mjs";
import {
  installTask,
  parseInstallResult,
  parseRemoveResult,
  removeTask,
  taskInstallScript,
  taskRemoveScript,
} from "../src/platform/win32/task.mjs";

const checks = [];
const localAppData = "C:\\Users\\fixture\\AppData\\Local";
const launcher = path.win32.join(localAppData, "ThriftyRelay", "Start-ThriftyRelay.ps1");
const tunnel = "C:\\fixture\\tunnel-client.exe";
const user = "FIXTURE\\fixture";

// The POSIX launcher is a later step. Asking for one must fail loudly instead of silently
// returning a path that no unit file or plist will ever read.
for (const platform of ["linux", "darwin", "aix"]) {
  assert.throws(() => launcherAdapter(platform), { code: "REMOTE_PLATFORM_UNSUPPORTED" }, platform);
  assert.throws(() => taskAdapter(platform), { code: "REMOTE_PLATFORM_UNSUPPORTED" }, platform);
}
checks.push("unimplemented-launcher-and-task-backends-fail-loudly");

assert.equal(launcherPath({ env: { LOCALAPPDATA: localAppData } }), launcher);
assert.throws(() => launcherPath({ env: {} }), { code: "LAUNCHER_PATH_UNAVAILABLE" });

const script = launcherScript({
  tunnel,
  tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
  mcpCommand: "node C:/fixture/ThriftyRelay/index.mjs",
  taskDirectory: "C:\\work\\$data",
  codexWorkspace: "C:\\work",
  tempWorkspace: "C:\\work\\$temp",
});
// mcp-control parses these three lines out of the generated file, one assignment per line and
// double quoted. A generated launcher that changes their shape breaks local diagnostics.
assert(script.includes(`$tunnel = "${tunnel}"`));
assert(script.includes('$mcpCommand = "node C:/fixture/ThriftyRelay/index.mjs"'));
assert(script.includes('$healthAddress = "127.0.0.1:8080"'));
assert(script.includes("CredRead"), "the credential must be read without a gallery module");
assert(script.includes('$credentialTarget = "ThriftyRelay/CONTROL_PLANE_API_KEY"'));
// A dollar sign in a path must survive PowerShell expansion.
assert(script.includes('$env:THRIFTYRELAY_TASK_DIR = "C:\\work\\`$data"'));
assert(script.includes('$env:THRIFTYRELAY_TEMP_WORKSPACE = "C:\\work\\`$temp"'));
assert.throws(() => launcherScript({ tunnel: "", tunnelId: "x", mcpCommand: "node x", taskDirectory: "C:\\x" }),
  { code: "LAUNCHER_CONFIG_INVALID" });
checks.push("launcher-script-keeps-the-lines-mcp-control-reads");

const atLogon = taskInstallScript({ name: "ThriftyRelay MCP", launcher, atLogon: true, user, resultFile: "C:\\temp\\result.json" });
assert(atLogon.includes(`-File "${launcher}"`));
assert(atLogon.includes("New-ScheduledTaskTrigger -AtLogOn"));
assert(atLogon.includes("$expectedTriggers = if ($atLogon) { 1 } else { 0 }"));
assert(atLogon.includes("HighestAvailable"));
assert(atLogon.includes("'ThriftyRelay MCP'"));

const onDemand = taskInstallScript({ name: "O'Brien MCP", launcher, atLogon: false, user, resultFile: "C:\\temp\\result.json" });
assert(!onDemand.includes("-AtLogOn"));
assert(onDemand.includes("'O''Brien MCP'"), "a quote must be doubled rather than end the string");
checks.push("task-script-registers-the-verified-shape");

for (const options of [
  { launcher: "relative.ps1", user, resultFile: "C:\\temp\\r.json" },
  { launcher, user: "", resultFile: "C:\\temp\\r.json" },
  { launcher, user, resultFile: "relative.json" },
]) {
  assert.throws(() => taskInstallScript(options), { code: "TASK_INSTALL_ARGUMENTS_INVALID" });
}
checks.push("task-script-rejects-relative-or-missing-arguments");

assert.deepEqual(parseInstallResult('{"ok":true,"name":"ThriftyRelay MCP","state":"Ready","atLogon":true}'),
  { ok: true, name: "ThriftyRelay MCP", state: "Ready", atLogon: true });
// Windows PowerShell writes Set-Content -Encoding UTF8 with a BOM.
assert.deepEqual(parseInstallResult('\uFEFF{"ok":true,"name":"ThriftyRelay MCP","state":"Ready"}'),
  { ok: true, name: "ThriftyRelay MCP", state: "Ready", atLogon: false });
assert.throws(() => parseInstallResult('{"ok":false,"code":"TASK_INSTALL_VERIFY_FAILED","detail":"shape"}'),
  { code: "TASK_INSTALL_VERIFY_FAILED" });
assert.throws(() => parseInstallResult("not json"), { code: "TASK_INSTALL_FAILED" });
checks.push("install-result-is-parsed-or-fails-closed");

const removeScript = taskRemoveScript({ name: "O'Brien MCP", resultFile: "C:\\temp\\remove.json" });
assert(removeScript.includes("Schedule.Service"));
assert(removeScript.includes("$folder.DeleteTask($name, 0)"));
assert(removeScript.includes("-2147024894"), "only the not-found HRESULT is treated as absent");
assert(removeScript.includes("'O''Brien MCP'"));
assert(removeScript.includes("TASK_REMOVE_VERIFY_FAILED"));
assert.deepEqual(parseRemoveResult('{"ok":true,"name":"ThriftyRelay MCP","removed":true}'),
  { ok: true, name: "ThriftyRelay MCP", removed: true });
assert.deepEqual(parseRemoveResult('{"ok":true,"name":"ThriftyRelay MCP","removed":false}'),
  { ok: true, name: "ThriftyRelay MCP", removed: false });
assert.throws(() => parseRemoveResult('{"ok":false,"code":"TASK_REMOVE_VERIFY_FAILED"}'),
  { code: "TASK_REMOVE_VERIFY_FAILED" });
assert.throws(() => parseRemoveResult("not json"), { code: "TASK_REMOVE_FAILED" });
assert.throws(() => taskRemoveScript({ name: "", resultFile: "C:\\temp\\r.json" }),
  { code: "TASK_REMOVE_ARGUMENTS_INVALID" });
checks.push("remove-script-unregisters-and-verifies");

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-task-test-"));
try {
  let elevated;
  const installed = await installTask({
    name: "ThriftyRelay MCP",
    launcher,
    atLogon: true,
    user,
    run: async (file, args) => {
      elevated = { file, args };
      // installTask writes the script before the elevated child runs; the result file is the
      // channel back from that child, so the fake supplies exactly what the child would.
      const scriptPath = /-File "([^"]+)"/.exec(args[3])[1];
      const generated = await fs.readFile(scriptPath, "utf8");
      assert(generated.includes("Register-ScheduledTask"));
      return { stdout: "", stderr: "" };
    },
    readFile: async () => '{"ok":true,"name":"ThriftyRelay MCP","state":"Ready","atLogon":true}',
  });
  assert.equal(elevated.file, "powershell.exe");
  assert(elevated.args.some(value => String(value).includes("-Verb RunAs")));
  assert.deepEqual(installed, { ok: true, name: "ThriftyRelay MCP", state: "Ready", atLogon: true });

  await assert.rejects(installTask({
    launcher,
    user,
    run: async () => { throw new Error("declined"); },
  }), { code: "TASK_INSTALL_ELEVATION_FAILED" });

  await assert.rejects(installTask({
    launcher,
    user,
    run: async () => ({ stdout: "", stderr: "" }),
    readFile: async () => { throw new Error("missing"); },
  }), { code: "TASK_INSTALL_FAILED" });

  let removeElevated;
  const removed = await removeTask({
    name: "ThriftyRelay MCP",
    run: async (file, args) => {
      removeElevated = { file, args };
      const scriptPath = /-File "([^"]+)"/.exec(args[3])[1];
      const generated = await fs.readFile(scriptPath, "utf8");
      assert(generated.includes("$folder.DeleteTask($name, 0)"));
      return { stdout: "", stderr: "" };
    },
    readFile: async () => '{"ok":true,"name":"ThriftyRelay MCP","removed":true}',
  });
  assert.equal(removeElevated.file, "powershell.exe");
  assert(removeElevated.args.some(value => String(value).includes("-Verb RunAs")));
  assert.deepEqual(removed, { ok: true, name: "ThriftyRelay MCP", removed: true });

  await assert.rejects(removeTask({
    name: "ThriftyRelay MCP",
    run: async () => { throw new Error("declined"); },
  }), { code: "TASK_REMOVE_ELEVATION_FAILED" });
  await assert.rejects(removeTask({
    name: "ThriftyRelay MCP",
    run: async () => ({ stdout: "", stderr: "" }),
    readFile: async () => { throw new Error("missing"); },
  }), { code: "TASK_REMOVE_FAILED" });
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
checks.push("install-and-remove-tasks-elevate-and-read-the-result-file");

console.log(`test-platform-task: ${checks.length} checks passed`);
