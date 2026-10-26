import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { psLiteral } from "./powershell.mjs";

const execFileAsync = promisify(execFile);

export const TASK_NAME = "ThriftyRelay MCP";
export const TASK_PATH = "\\";
const TASK_DESCRIPTION = "Starts the ThriftyRelay MCP tunnel and local server";

function taskError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

// The task is created from the same fields the running system was verified with: a logon
// trigger bound to the account, an interactive token so the tunnel can use the user's
// credential store, and the highest run level so the launcher can reach the tunnel client.
// Registration replaces an existing definition rather than editing it, because a trigger that
// is not in the new definition must not survive from the old one.
export function taskInstallScript({ name = TASK_NAME, launcher, atLogon = true, user, description = TASK_DESCRIPTION, resultFile }) {
  if (typeof launcher !== "string" || !path.win32.isAbsolute(launcher)) throw taskError("TASK_INSTALL_ARGUMENTS_INVALID", "launcher");
  if (typeof user !== "string" || !user) throw taskError("TASK_INSTALL_ARGUMENTS_INVALID", "user");
  if (typeof resultFile !== "string" || !path.win32.isAbsolute(resultFile)) throw taskError("TASK_INSTALL_ARGUMENTS_INVALID", "resultFile");
  const arguments_ = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcher}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$resultFile = " + psLiteral(resultFile),
    "$result = @{ ok = $false; code = 'TASK_INSTALL_FAILED' }",
    "try {",
    "  $name = " + psLiteral(name),
    "  $arguments = " + psLiteral(arguments_),
    "  $atLogon = " + (atLogon ? "$true" : "$false"),
    "  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments",
    "  $principal = New-ScheduledTaskPrincipal -UserId " + psLiteral(user) + " -LogonType Interactive -RunLevel Highest",
    "  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval ([TimeSpan]::FromMinutes(1)) -StartWhenAvailable -RunOnlyIfNetworkAvailable",
    "  if ($null -ne (Get-ScheduledTask -TaskName $name -TaskPath " + psLiteral(TASK_PATH) + " -ErrorAction SilentlyContinue)) {",
    "    Unregister-ScheduledTask -TaskName $name -TaskPath " + psLiteral(TASK_PATH) + " -Confirm:$false -ErrorAction Stop",
    "  }",
    "  $registration = @{",
    "    TaskName = $name; TaskPath = " + psLiteral(TASK_PATH) + "; Action = $action;",
    "    Principal = $principal; Settings = $settings; Description = " + psLiteral(description),
    "  }",
    ...(atLogon
      ? ["  $registration.Trigger = New-ScheduledTaskTrigger -AtLogOn -User " + psLiteral(user)]
      : []),
    "  Register-ScheduledTask @registration | Out-Null",
    "  $task = Get-ScheduledTask -TaskName $name -TaskPath " + psLiteral(TASK_PATH) + " -ErrorAction Stop",
    "  $xml = [xml](Export-ScheduledTask -TaskName $name -TaskPath " + psLiteral(TASK_PATH) + ")",
    "  $exec = $xml.SelectSingleNode(\"//*[local-name()='Actions']/*[local-name()='Exec']\")",
    "  $runLevel = $xml.SelectSingleNode(\"//*[local-name()='Principal']/*[local-name()='RunLevel']\")",
    "  $logonType = $xml.SelectSingleNode(\"//*[local-name()='Principal']/*[local-name()='LogonType']\")",
    "  $logonTriggers = @($xml.SelectNodes(\"//*[local-name()='Triggers']/*[local-name()='LogonTrigger']\"))",
    "  $expectedTriggers = if ($atLogon) { 1 } else { 0 }",
    "  if ($null -eq $exec -or [string]$exec.Command -ne 'powershell.exe' -or",
    "      ([string]$exec.Arguments).Trim() -ne $arguments -or",
    "      $null -eq $runLevel -or [string]$runLevel.InnerText -ne 'HighestAvailable' -or",
    "      $null -eq $logonType -or [string]$logonType.InnerText -ne 'InteractiveToken' -or",
    "      $logonTriggers.Count -ne $expectedTriggers) {",
    "    throw 'TASK_INSTALL_VERIFY_FAILED'",
    "  }",
    "  $result = @{ ok = $true; name = $name; state = [string]$task.State; atLogon = $atLogon }",
    "} catch {",
    "  $code = if ($_.Exception.Message -eq 'TASK_INSTALL_VERIFY_FAILED') { 'TASK_INSTALL_VERIFY_FAILED' } else { 'TASK_INSTALL_FAILED' }",
    "  $result = @{ ok = $false; code = $code; detail = $_.Exception.Message }",
    "} finally {",
    "  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultFile -Encoding UTF8",
    "}",
    "",
  ].join("\n");
}

// Removal is also an attended elevated step: a task registered with HighestAvailable cannot be
// unregistered reliably from a non-elevated process. The result file carries the verdict back
// because the elevated child has no console connection to the caller.
export function taskRemoveScript({ name = TASK_NAME, resultFile } = {}) {
  if (typeof name !== "string" || !name) throw taskError("TASK_REMOVE_ARGUMENTS_INVALID", "name");
  if (typeof resultFile !== "string" || !path.win32.isAbsolute(resultFile)) {
    throw taskError("TASK_REMOVE_ARGUMENTS_INVALID", "resultFile");
  }
  // The COM API is preferred over the ScheduledTasks module here: its "not found" result is a
  // stable HRESULT, while the cmdlet's localized error text cannot distinguish a missing task
  // from a provider or permission failure. Treating that failure as "already absent" would let
  // uninstall report success while the task is still registered.
  return [
    "$ErrorActionPreference = 'Stop'",
    "$resultFile = " + psLiteral(resultFile),
    "$result = @{ ok = $false; code = 'TASK_REMOVE_FAILED' }",
    "try {",
    "  $name = " + psLiteral(name),
    "  $scheduler = New-Object -ComObject 'Schedule.Service'",
    "  $scheduler.Connect()",
    "  $folder = $scheduler.GetFolder(" + psLiteral(TASK_PATH) + ")",
    "  $task = $null",
    "  try { $task = $folder.GetTask($name) } catch {",
    "    if ($_.Exception.HResult -ne -2147024894) { throw }",
    "  }",
    "  $removed = $null -ne $task",
    "  if ($removed) { $folder.DeleteTask($name, 0) }",
    "  $remaining = $null",
    "  try { $remaining = $folder.GetTask($name) } catch {",
    "    if ($_.Exception.HResult -ne -2147024894) { throw }",
    "  }",
    "  if ($null -ne $remaining) { throw 'TASK_REMOVE_VERIFY_FAILED' }",
    "  $result = @{ ok = $true; name = $name; removed = $removed }",
    "} catch {",
    "  $code = if ($_.Exception.Message -eq 'TASK_REMOVE_VERIFY_FAILED') { 'TASK_REMOVE_VERIFY_FAILED' } else { 'TASK_REMOVE_FAILED' }",
    "  $result = @{ ok = $false; code = $code; detail = $_.Exception.Message }",
    "} finally {",
    "  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultFile -Encoding UTF8",
    "}",
    "",
  ].join("\n");
}

export function parseRemoveResult(source) {
  let parsed;
  try { parsed = JSON.parse(String(source).replace(/^\uFEFF/, "")); } catch { throw taskError("TASK_REMOVE_FAILED", "result"); }
  if (parsed?.ok === true && typeof parsed.name === "string" && typeof parsed.removed === "boolean") {
    return { ok: true, name: parsed.name, removed: parsed.removed };
  }
  throw taskError(typeof parsed?.code === "string" ? parsed.code : "TASK_REMOVE_FAILED",
    typeof parsed?.detail === "string" ? parsed.detail : undefined);
}

export function parseInstallResult(source) {
  let parsed;
  try { parsed = JSON.parse(String(source).replace(/^\uFEFF/, "")); } catch { throw taskError("TASK_INSTALL_FAILED", "result"); }
  if (parsed?.ok === true && typeof parsed.name === "string" && typeof parsed.state === "string") {
    return { ok: true, name: parsed.name, state: parsed.state, atLogon: parsed.atLogon === true };
  }
  throw taskError(typeof parsed?.code === "string" ? parsed.code : "TASK_INSTALL_FAILED",
    typeof parsed?.detail === "string" ? parsed.detail : undefined);
}

// Registration needs an administrator, so this is the one attended step in setup. The work is
// done by an elevated child that writes its verdict to a file: the child's console is not
// connected to the caller, and a failure must not read as success.
export async function installTask({
  name = TASK_NAME,
  launcher,
  atLogon = true,
  user = `${process.env.USERDOMAIN || ""}\\${process.env.USERNAME || ""}`,
  run = execFileAsync,
  readFile = fs.readFile,
  makeTemp = () => fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-task-")),
  removeTemp = directory => fs.rm(directory, { recursive: true, force: true }),
} = {}) {
  const workspace = await makeTemp();
  const scriptFile = path.join(workspace, "install.ps1");
  const resultFile = path.join(workspace, "result.json");
  try {
    await fs.writeFile(scriptFile, taskInstallScript({ name, launcher, atLogon, user, resultFile }),
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    const command = "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList " +
      psLiteral(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`) +
      " -Verb RunAs -Wait -PassThru; exit $p.ExitCode";
    try {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 });
    } catch {
      throw taskError("TASK_INSTALL_ELEVATION_FAILED");
    }
    let source;
    try { source = await readFile(resultFile, "utf8"); }
    catch { throw taskError("TASK_INSTALL_FAILED", "result"); }
    return parseInstallResult(source);
  } finally {
    await removeTemp(workspace).catch(() => {});
  }
}

function controlScript(cmdlet, name) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `${cmdlet} -TaskName ${psLiteral(name)} -TaskPath ${psLiteral(TASK_PATH)} -ErrorAction Stop`,
  ].join("\n");
}

export async function startTask({ name = TASK_NAME, run = execFileAsync } = {}) {
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", controlScript("Start-ScheduledTask", name)],
    { windowsHide: true, timeout: 30_000 });
}

export async function stopTask({ name = TASK_NAME, run = execFileAsync } = {}) {
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", controlScript("Stop-ScheduledTask", name)],
    { windowsHide: true, timeout: 30_000 });
}

export async function removeTask({
  name = TASK_NAME,
  run = execFileAsync,
  readFile = fs.readFile,
  makeTemp = () => fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-task-remove-")),
  removeTemp = directory => fs.rm(directory, { recursive: true, force: true }),
} = {}) {
  const workspace = await makeTemp();
  const scriptFile = path.join(workspace, "remove.ps1");
  const resultFile = path.join(workspace, "result.json");
  try {
    await fs.writeFile(scriptFile, taskRemoveScript({ name, resultFile }),
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    const command = "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList " +
      psLiteral(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`) +
      " -Verb RunAs -Wait -PassThru; exit $p.ExitCode";
    try {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 });
    } catch {
      throw taskError("TASK_REMOVE_ELEVATION_FAILED");
    }
    let source;
    try { source = await readFile(resultFile, "utf8"); }
    catch { throw taskError("TASK_REMOVE_FAILED", "result"); }
    return parseRemoveResult(source);
  } finally {
    await removeTemp(workspace).catch(() => {});
  }
}

export async function readTask({ name = TASK_NAME, run = execFileAsync } = {}) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskName ${psLiteral(name)} -TaskPath ${psLiteral(TASK_PATH)} -ErrorAction Stop`,
    "[pscustomobject]@{ name = [string]$task.TaskName; state = [string]$task.State } | ConvertTo-Json -Compress",
  ].join("\n");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 });
  let parsed;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { throw taskError("TASK_QUERY_FAILED"); }
  if (typeof parsed?.name !== "string" || typeof parsed?.state !== "string") throw taskError("TASK_QUERY_FAILED");
  return { name: parsed.name, state: parsed.state };
}
