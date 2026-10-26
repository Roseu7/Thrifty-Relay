import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectRecovery } from "../src/mcp/recovery.mjs";
import { formatLanguageError, parseLanguageFlags, resolveLanguagePreference, translate } from "../src/i18n/index.mjs";
import { withSpinner } from "../src/cli/spinner.mjs";
import { pathsAdapter } from "../src/platform/index.mjs";
import { psLiteral } from "../src/platform/win32/powershell.mjs";
import { PowerShellSession } from "./powershell-session.mjs";

const execFileAsync = promisify(execFile);
const TASK_NAME = "ThriftyRelay MCP";
export const KNOWN_TASK_NAMES = Object.freeze([TASK_NAME]);
const TASK_NAMES = KNOWN_TASK_NAMES;
const TASK_PATH = "\\";
const ROOT = path.resolve(import.meta.dirname, "..");
const ENTRYPOINT = path.join(ROOT, "index.mjs");
const COMMANDER_ENTRYPOINT = path.join(ROOT, "node_modules", "@wonderwhy-er", "desktop-commander", "dist", "index.js");
const NODE_EXECUTABLE = process.execPath;
const LAUNCHER = path.join(process.env.LOCALAPPDATA || "", "ThriftyRelay", "Start-ThriftyRelay.ps1");
async function waitForNextPoll(now, sleep, intervalMs, pollStarted) {
  const remainingMs = Math.max(0, intervalMs - (now() - pollStarted));
  if (remainingMs > 0) await sleep(remainingMs);
}

function scheduledTaskQueryScript() {
  return [
    "$scheduler = New-Object -ComObject 'Schedule.Service'",
    "$scheduler.Connect()",
    "$taskFolder = $scheduler.GetFolder('\\')",
    // Include hidden tasks and do not suppress access/query failures.
    "$tasks = @(foreach ($registeredTask in $taskFolder.GetTasks(1)) {",
    "  if ($taskNames -notcontains [string]$registeredTask.Name) { continue }",
    "  if ([string]$registeredTask.Path -ine ('\\' + [string]$registeredTask.Name)) { throw 'MCP_TASK_PATH_CHANGED' }",
    "  $taskState = switch ([int]$registeredTask.State) { 3 { 'Ready' } 4 { 'Running' } default { 'Unknown' } }",
    "  $definition = $registeredTask.Definition",
    "  $taskActions = @(foreach ($action in $definition.Actions) {",
    "    if ([int]$action.Type -eq 0) { [pscustomobject]@{ Execute = [string]$action.Path; Arguments = [string]$action.Arguments } }",
    "    else { [pscustomobject]@{ Execute = 'invalid-task-action'; Arguments = '' } }",
    "  })",
    "  [pscustomobject]@{ TaskName = [string]$registeredTask.Name; TaskPath = '\\'; State = $taskState; Actions = $taskActions; RegisteredTask = $registeredTask }",
    "})",
  ].join("\n");
}

async function invokePowerShell(script, code, session) {
  if (session) return session.run(script, code);
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } catch {
    throw Object.assign(new Error(), { code });
  }
}

export function readStateScript() {
  const taskNames = "@(" + TASK_NAMES.map(psLiteral).join(",") + ")";
  return [
    "$ErrorActionPreference = 'Stop'",
    "$launcher = " + psLiteral(LAUNCHER),
    "$entrypoint = " + psLiteral(ENTRYPOINT),
    "$commanderEntrypoint = " + psLiteral(COMMANDER_ENTRYPOINT),
    "$nodeExecutable = " + psLiteral(NODE_EXECUTABLE),
    "$taskPath = " + psLiteral(TASK_PATH),
    "$taskNames = " + taskNames,
    "function Read-LauncherValue([string]$name) {",
    "  $pattern = '(?im)^\\s*\\$' + [regex]::Escape($name) + '\\s*=\\s*\"([^\"]+)\"\\s*$'",
    "  $match = [regex]::Match($launcherText, $pattern)",
    "  if (!$match.Success) { throw 'MCP_LAUNCHER_CONFIGURATION_INVALID' }",
    "  return $match.Groups[1].Value",
    "}",
    "if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'MCP_LAUNCHER_UNAVAILABLE' }",
    "$launcherText = Get-Content -LiteralPath $launcher -Raw -ErrorAction Stop",
    "$tunnelPath = [IO.Path]::GetFullPath((Read-LauncherValue 'tunnel'))",
    "$mcpCommand = (Read-LauncherValue 'mcpCommand').Replace('/', '\\')",
    "$healthAddress = Read-LauncherValue 'healthAddress'",
    "if ([IO.Path]::GetExtension($tunnelPath) -ine '.exe' -or",
    "    $mcpCommand -ine ('node ' + $entrypoint.Replace('/', '\\')) -or $healthAddress -cne '127.0.0.1:8080' -or",
    "    !(Test-Path -LiteralPath $tunnelPath -PathType Leaf)) { throw 'MCP_LAUNCHER_CONFIGURATION_CHANGED' }",
    "$expectedPowerShell = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'))",
    "$launcherArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $launcher + '\"'",
    "$launcherArgsUnquoted = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $launcher",
    "$launcherInvocationPattern = '(?i)(?:^|\\s)-File\\s+(?:\"' + [regex]::Escape($launcher) + '\"|' + [regex]::Escape($launcher) + ')(?:\\s|$)'",
    scheduledTaskQueryScript(),
    "$taskInfo = [pscustomobject]@{ count = $tasks.Count; name = $null; state = $null; path = $taskPath; actionValid = $false; actionCount = 0 }",
    "if ($tasks.Count -eq 1) {",
    "  $task = $tasks[0]",
    "  $actions = @($task.Actions)",
    "  $actionValid = $false",
    "  if ($actions.Count -eq 1) {",
    "    $action = $actions[0]",
    "    $args = ([string]$action.Arguments).Trim()",
    "    $execute = [string]$action.Execute",
    "    $validArgs = [string]::Equals($args, $launcherArgs, [StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($args, $launcherArgsUnquoted, [StringComparison]::OrdinalIgnoreCase)",
    "    $validExecute = [string]::Equals($execute, 'powershell.exe', [StringComparison]::OrdinalIgnoreCase) -or [string]::Equals([IO.Path]::GetFullPath($execute), $expectedPowerShell, [StringComparison]::OrdinalIgnoreCase)",
    "    $actionValid = $validArgs -and $validExecute",
    "  }",
    "  $taskInfo = [pscustomobject]@{ count = 1; name = [string]$task.TaskName; state = [string]$task.State; path = [string]$task.TaskPath; actionValid = $actionValid; actionCount = $actions.Count }",
    "}",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$byPid = @{}",
    "foreach ($item in $all) { $byPid[[int]$item.ProcessId] = $item }",
    "$launcherPattern = '(?i)^\\s*(?:\"' + [regex]::Escape($expectedPowerShell) + '\"|' + [regex]::Escape($expectedPowerShell) + '|\"powershell\\.exe\"|powershell\\.exe)\\s+-NoProfile\\s+-ExecutionPolicy\\s+Bypass\\s+-WindowStyle\\s+Hidden\\s+-File\\s+(?:\"' + [regex]::Escape($launcher) + '\"|' + [regex]::Escape($launcher) + ')\\s*$'",
    "$tunnelPattern = '(?i)^\\s*(?:\"' + [regex]::Escape($tunnelPath) + '\"|' + [regex]::Escape($tunnelPath) + ')\\s+run\\s+--mcp\\.command\\s+\"node\\s+' + [regex]::Escape($entrypoint.Replace('/', '\\')) + '\"\\s+--health\\.listen-addr\\s+\"127\\.0\\.0\\.1:8080\"\\s*$'",
    "$nodeExePattern = '(?:\"' + [regex]::Escape($nodeExecutable) + '\"|' + [regex]::Escape($nodeExecutable) + '|\"?node(?:\\.exe)?\"?)'",
    "$nodeCommandPattern = '(?i)^\\s*' + $nodeExePattern + '\\s+\"?' + [regex]::Escape($entrypoint.Replace('/', '\\')) + '\"?\\s*$'",
    "$commanderCommandPattern = '(?i)^\\s*' + $nodeExePattern + '\\s+\"?' + [regex]::Escape($commanderEntrypoint.Replace('/', '\\')) + '\"?\\s*$'",
    "$classified = @{}",
    "foreach ($item in $all) {",
    "  $command = [string]$item.CommandLine",
    "  $normalized = $command.Replace('/', '\\')",
    "  $exe = [string]$item.ExecutablePath",
    "  $name = [string]$item.Name",
    "  $launcherCandidate = ($name -ieq 'powershell.exe' -and $normalized -match $launcherInvocationPattern)",
    "  $tunnelCandidate = ($name -ieq [IO.Path]::GetFileName($tunnelPath))",
    "  $mcpCandidate = ($name -ieq 'node.exe' -and $normalized.IndexOf($entrypoint.Replace('/', '\\'), [StringComparison]::OrdinalIgnoreCase) -ge 0)",
    "  $commanderCandidate = ($name -ieq 'node.exe' -and $normalized.IndexOf($commanderEntrypoint.Replace('/', '\\'), [StringComparison]::OrdinalIgnoreCase) -ge 0)",
    "  $launcherValid = $launcherCandidate -and $exe -ieq $expectedPowerShell -and $normalized -match $launcherPattern",
    "  $tunnelValid = $tunnelCandidate -and $exe -ieq $tunnelPath -and $normalized -match $tunnelPattern",
    "  $mcpValid = $mcpCandidate -and $exe -ieq $nodeExecutable -and $normalized -match $nodeCommandPattern",
    "  $commanderValid = $commanderCandidate -and $exe -ieq $nodeExecutable -and $normalized -match $commanderCommandPattern",
    "  $roles = @()",
    "  if ($launcherCandidate) { $roles += 'launcher' }",
    "  if ($tunnelCandidate) { $roles += 'tunnel' }",
    "  if ($mcpCandidate) { $roles += 'mcp' }",
    "  if ($commanderCandidate) { $roles += 'desktopCommander' }",
    "  if ($roles.Count -eq 0) { continue }",
    "  $created = $null",
    "  if ($item.CreationDate) { try { $created = $item.CreationDate.ToUniversalTime().ToString('o') } catch {} }",
    "  $hash = $null",
    "  if ($command) {",
    "    $sha = [Security.Cryptography.SHA256]::Create()",
    "    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }",
    "  }",
    "  $classified[[int]$item.ProcessId] = [pscustomobject]@{ pid = [int]$item.ProcessId; parentPid = [int]$item.ParentProcessId; name = $name; executablePath = $exe; startedAt = $created; commandHash = $hash; launcherCandidate = $launcherCandidate; tunnelCandidate = $tunnelCandidate; mcpCandidate = $mcpCandidate; commanderCandidate = $commanderCandidate; launcher = $launcherValid; tunnel = $tunnelValid; mcp = $mcpValid; desktopCommander = $commanderValid; roles = $roles }",
    "}",
    "$tracked = New-Object 'System.Collections.Generic.HashSet[int]'",
    "foreach ($row in $classified.Values) { [void]$tracked.Add([int]$row.pid) }",
    "for ($depth = 0; $depth -lt 32; $depth++) {",
    "  $added = $false",
    "  foreach ($item in $all) {",
    "    $parent = $byPid[[int]$item.ParentProcessId]",
    "    if ($parent -and $parent.CreationDate -and $item.CreationDate -and $tracked.Contains([int]$item.ParentProcessId) -and $item.CreationDate.ToUniversalTime() -ge $parent.CreationDate.ToUniversalTime() -and $tracked.Add([int]$item.ProcessId)) { $added = $true }",
    "  }",
    "  if (!$added) { break }",
    "}",
    "$processes = @()",
    "foreach ($item in $all) {",
    "  $id = [int]$item.ProcessId",
    "  $base = $classified[$id]",
    "  if (!$base -and !$tracked.Contains($id)) { continue }",
    "  if ($base) { $row = $base } else {",
    "    $created = $null",
    "    if ($item.CreationDate) { try { $created = $item.CreationDate.ToUniversalTime().ToString('o') } catch {} }",
    "    $command = [string]$item.CommandLine",
    "    $hash = $null",
    "    if ($command) { $sha = [Security.Cryptography.SHA256]::Create(); try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($command.Replace('/', '\\')))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() } }",
    "    $row = [pscustomobject]@{ pid = $id; parentPid = [int]$item.ParentProcessId; name = [string]$item.Name; executablePath = [string]$item.ExecutablePath; startedAt = $created; commandHash = $hash; launcherCandidate = $false; tunnelCandidate = $false; mcpCandidate = $false; commanderCandidate = $false; launcher = $false; tunnel = $false; mcp = $false; desktopCommander = $false; roles = @('other') }",
    "  }",
    "  $row | Add-Member -NotePropertyName parentExists -NotePropertyValue $byPid.ContainsKey([int]$row.parentPid) -Force",
    "  $processes += $row",
    "}",
    "$listenerQueryValid = $true",
    "$listeners = @()",
    "try { $listeners = @(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; address = [string]$_.LocalAddress } }) } catch { $listenerQueryValid = $false }",
    "[pscustomobject]@{ task = $taskInfo; processes = $processes; listeners = $listeners; listenerQueryValid = $listenerQueryValid } | ConvertTo-Json -Depth 6 -Compress",
  ].join("\n");
}

export async function readWindowsState(session) {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    throw Object.assign(new Error(), { code: "MCP_WINDOWS_ONLY" });
  }
  const output = await invokePowerShell(readStateScript(), "MCP_WINDOWS_QUERY_FAILED", session);
  try {
    const state = JSON.parse(output.trim());
    return state;
  } catch {
    throw Object.assign(new Error(), { code: "MCP_WINDOWS_QUERY_FAILED" });
  }
}

export function readMonitorStateScript(expectedProcesses = []) {
  const expectedPids = [...new Set((Array.isArray(expectedProcesses) ? expectedProcesses : [])
    .flatMap(process => [process.pid, process.parentPid])
    .filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const clauses = [
    ...expectedPids.flatMap(pid => [`ProcessId = ${pid}`, `ParentProcessId = ${pid}`]),
    "Name = 'powershell.exe'", "Name = 'node.exe'",
  ];
  const fullScan = "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)";
  const fullScript = readStateScript();
  if (!fullScript.includes(fullScan)) throw new Error("MCP_MONITOR_SCRIPT_SOURCE_INVALID");
  // The tunnel binary is whatever setup recorded in the launcher, so its name joins the filter
  // here. WQL escapes a quote with a backslash; a Windows file name cannot contain one itself.
  return fullScript.replace(fullScan, [
    "$tunnelFilterName = [IO.Path]::GetFileName($tunnelPath).Replace(\"'\", \"\\'\")",
    "$all = @(Get-CimInstance Win32_Process -Filter (" + psLiteral(clauses.join(" OR ")) +
      " + \" OR Name = '\" + $tunnelFilterName + \"'\") -ErrorAction Stop)",
  ].join("\n"));
}

export async function readWindowsMonitorState(expectedProcesses, session) {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    throw Object.assign(new Error(), { code: "MCP_WINDOWS_ONLY" });
  }
  const output = await invokePowerShell(readMonitorStateScript(expectedProcesses), "MCP_WINDOWS_QUERY_FAILED", session);
  try {
    const state = JSON.parse(output.trim());
    return state;
  }
  catch { throw Object.assign(new Error(), { code: "MCP_WINDOWS_QUERY_FAILED" }); }
}

export function taskActionScript(taskName, requiredState, operation) {
  const taskNames = "@(" + TASK_NAMES.map(psLiteral).join(",") + ")";
  return [
    "$ErrorActionPreference = 'Stop'",
    "$taskNames = " + taskNames,
    "$expectedName = " + psLiteral(taskName),
    "$expectedState = " + psLiteral(requiredState),
    "$launcher = " + psLiteral(LAUNCHER),
    "$expectedArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $launcher + '\"'",
    "$expectedArgsUnquoted = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $launcher",
    scheduledTaskQueryScript(),
    "if ($tasks.Count -ne 1 -or [string]$tasks[0].TaskName -cne $expectedName -or [string]$tasks[0].TaskPath -cne '\\' -or [string]$tasks[0].State -cne $expectedState) { throw 'MCP_TASK_CHANGED' }",
    "$task = $tasks[0]",
    "$actions = @($task.Actions)",
    "if ($actions.Count -ne 1 -or (![string]::Equals([string]$actions[0].Execute, 'powershell.exe', [StringComparison]::OrdinalIgnoreCase) -and ![string]::Equals([IO.Path]::GetFullPath([string]$actions[0].Execute), [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')), [StringComparison]::OrdinalIgnoreCase))) { throw 'MCP_TASK_ACTION_CHANGED' }",
    "$args = ([string]$actions[0].Arguments).Trim()",
    "if (![string]::Equals($args, $expectedArgs, [StringComparison]::OrdinalIgnoreCase) -and ![string]::Equals($args, $expectedArgsUnquoted, [StringComparison]::OrdinalIgnoreCase)) { throw 'MCP_TASK_ACTION_CHANGED' }",
    operation === "stop" ? "$task.RegisteredTask.Stop(0)" : "[void]$task.RegisteredTask.Run($null)",
  ].join("\n");
}

async function changeScheduledTask(operation, taskName, session) {
  if (process.platform !== "win32") throw Object.assign(new Error(), { code: "MCP_WINDOWS_ONLY" });
  if (!TASK_NAMES.includes(taskName)) throw Object.assign(new Error(), { code: "MCP_TASK_NOT_FOUND_OR_AMBIGUOUS" });
  const requiredState = operation === "stop" ? "Running" : "Ready";
  await invokePowerShell(taskActionScript(taskName, requiredState, operation),
    operation === "stop" ? "MCP_TASK_STOP_FAILED" : "MCP_TASK_START_FAILED", session);
}

function missingIdentityFields(process) {
  const missing = [];
  if (!Number.isSafeInteger(process?.pid) || process.pid <= 0) missing.push("ProcessId");
  if (!Number.isSafeInteger(process?.parentPid) || process.parentPid < 0) missing.push("ParentProcessId");
  if (typeof process?.startedAt !== "string" || !Number.isFinite(Date.parse(process.startedAt))) missing.push("CreationDate");
  if (typeof process?.executablePath !== "string" || !path.win32.isAbsolute(process.executablePath)) missing.push("ExecutablePath");
  if (!/^[a-f0-9]{64}$/i.test(process?.commandHash || "")) missing.push("CommandLine fingerprint");
  return missing;
}

function hasValidIdentity(process) {
  return missingIdentityFields(process).length === 0;
}

function processSummary(process) {
  return {
    pid: Number.isSafeInteger(process?.pid) ? process.pid : null,
    name: typeof process?.name === "string" && /^[\w .()-]{1,100}$/.test(process.name) ? process.name : "unknown",
    missing: missingIdentityFields(process),
  };
}

function taskError(state) {
  const task = state?.task;
  if (!task || task.count !== 1 || task.path !== TASK_PATH || !TASK_NAMES.includes(task.name)) {
    return "MCP_TASK_NOT_FOUND_OR_AMBIGUOUS";
  }
  if (task.actionCount !== 1 || task.actionValid !== true) return "MCP_TASK_ACTION_CHANGED";
  if (!new Set(["Ready", "Running"]).has(task.state)) return "MCP_TASK_STATE_INVALID";
  return null;
}

export function validateTaskSnapshot(state) {
  const error = taskError(state);
  return error
    ? { ok: false, code: error }
    : { ok: true, taskName: state.task.name, state: state.task.state };
}

function validateListeners(state, tunnelPid, allowEmpty) {
  if (state.listenerQueryValid !== true || !Array.isArray(state.listeners)) return "MCP_LISTENER_QUERY_FAILED";
  const owners = [...new Set(state.listeners.map(listener => listener.pid))];
  if (allowEmpty && owners.length === 0) return null;
  if (owners.length !== 1 || owners[0] !== tunnelPid || state.listeners.length === 0) {
    return "MCP_LISTENER_OWNERSHIP_INVALID";
  }
  return null;
}

function candidateRows(processes, key) {
  return processes.filter(process => process[key] === true);
}

function validateCandidateRows(processes) {
  const matchedTypes = {
    launcherCandidate: "launcher", tunnelCandidate: "tunnel",
    mcpCandidate: "mcp", commanderCandidate: "desktopCommander",
  };
  for (const process of processes) {
    if (process.roles?.length !== 1 || !hasValidIdentity(process)) return "MCP_PROCESS_IDENTITY_UNAVAILABLE";
    for (const [candidate, role] of Object.entries(matchedTypes)) {
      if (process[candidate] === true && process[role] !== true) return "MCP_PROCESS_IDENTITY_MISMATCH";
    }
  }
  return null;
}

function descendantsOf(processes, rootPid) {
  const ids = new Set([rootPid]);
  const byPid = new Map(processes.map(process => [process.pid, process]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      const parent = byPid.get(process.parentPid);
      if (!ids.has(process.pid) && ids.has(process.parentPid) && parent &&
          Date.parse(process.startedAt) >= Date.parse(parent.startedAt)) {
        ids.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.filter(process => ids.has(process.pid));
}

function classifyState(state) {
  const processes = Array.isArray(state?.processes) ? state.processes : [];
  const candidates = processes.filter(process =>
    process.launcherCandidate === true || process.tunnelCandidate === true ||
    process.mcpCandidate === true || process.commanderCandidate === true);
  const checked = classifyManagedState(state, candidates);
  const processDiagnostics = candidates.filter(process =>
    !hasValidIdentity(process) || process.roles?.length !== 1 ||
    (process.launcherCandidate && !process.launcher) || (process.tunnelCandidate && !process.tunnel) ||
    (process.mcpCandidate && !process.mcp) || (process.commanderCandidate && !process.desktopCommander))
    .map(process => ({ ...processSummary(process),
      ...(process.roles?.length !== 1 ? { invalidRole: true } : {}),
      ...(hasValidIdentity(process) ? { identityMismatch: true } : {}),
    }));
  return { ...checked,
    ...(processDiagnostics.length ? { processDiagnostics } : {}),
    ...(processes.length > candidates.length ? { additionalProcesses: processes.filter(process => !candidates.includes(process)).map(processSummary) } : {}),
  };
}

function classificationDetails(checked) {
  return {
    ...(checked.processDiagnostics ? { processDiagnostics: checked.processDiagnostics } : {}),
    ...(checked.additionalProcesses ? { additionalProcesses: checked.additionalProcesses } : {}),
  };
}

function classifyManagedState(state, candidates) {
  const invalidTask = taskError(state);
  if (invalidTask) return { error: invalidTask };
  const invalidCandidate = validateCandidateRows(candidates);
  if (invalidCandidate) return { error: invalidCandidate };
  // Only verified role candidates can be managed or passed to orphan cleanup.
  const processes = candidates;
  const launchers = candidateRows(processes, "launcher");
  const tunnels = candidateRows(processes, "tunnel");
  const mcps = candidateRows(processes, "mcp");
  const commanders = candidateRows(processes, "desktopCommander");
  const allCandidates = launchers.length + tunnels.length + mcps.length + commanders.length;
  const listenerError = state.listenerQueryValid === true && Array.isArray(state.listeners)
    ? null : "MCP_LISTENER_QUERY_FAILED";
  if (listenerError) return { error: listenerError };

  if (state.task.state === "Ready" && allCandidates === 0) {
    const portError = validateListeners(state, null, true);
    return portError ? { error: portError } : { kind: "ready", taskName: state.task.name, signature: "ready" };
  }

  if (state.task.state === "Ready") {
    if (launchers.length !== 0) return { error: "MCP_READY_LAUNCHER_PRESENT" };
    if (tunnels.length !== 1 || mcps.length !== 1 || commanders.length !== 1 ||
        candidates.length !== 3 || tunnels[0].parentExists !== false ||
        mcps[0].parentPid !== tunnels[0].pid || commanders[0].parentPid !== mcps[0].pid) {
      return { error: "MCP_ORPHAN_PROCESS_SET_INVALID" };
    }
    const portError = validateListeners(state, tunnels[0].pid, false);
    if (portError) return { error: portError };
    const owned = [commanders[0], mcps[0], tunnels[0]];
    if (descendantsOf(processes, tunnels[0].pid).length !== 3) {
      return { error: "MCP_ORPHAN_PROCESS_TREE_INVALID" };
    }
    return {
      kind: "orphan",
      taskName: state.task.name,
      processes: owned,
      signature: owned.map(processIdentity).join("|") + "|" + tunnels[0].pid,
    };
  }

  if (launchers.length !== 1 || tunnels.length !== 1 || mcps.length !== 1 || commanders.length !== 1 ||
      candidates.length !== 4 || tunnels[0].parentPid !== launchers[0].pid ||
      mcps[0].parentPid !== tunnels[0].pid || commanders[0].parentPid !== mcps[0].pid) {
    return { error: "MCP_RUNNING_PROCESS_SET_INVALID" };
  }
  const tree = descendantsOf(processes, launchers[0].pid);
  if (tree.length !== 4 || tree.length !== processes.length || !tree.some(process => process.pid === tunnels[0].pid) ||
      !tree.some(process => process.pid === mcps[0].pid) ||
      !tree.some(process => process.pid === commanders[0].pid)) {
    return { error: "MCP_RUNNING_PROCESS_TREE_INVALID" };
  }
  const portError = validateListeners(state, tunnels[0].pid, false);
  if (portError) return { error: portError };
  const signature = [launchers[0], tunnels[0], mcps[0], commanders[0]]
    .map(processIdentity).join("|") + "|" + tunnels[0].pid;
  return { kind: "running", taskName: state.task.name, launchers, processes: tree, signature };
}

function processIdentity(process) {
  return [process.pid, process.startedAt, process.executablePath, process.commandHash].join("@");
}

async function readLocks(inspectLocks) {
  try {
    const locks = await inspectLocks();
    if (!locks || !Object.hasOwn(locks, "active") || !Object.hasOwn(locks, "maintenance")) {
      return { error: "MCP_LOCK_INSPECTION_FAILED" };
    }
    if (locks.maintenance) return { error: "MCP_MAINTENANCE_LOCK_PRESENT" };
    if (locks.scoped && (locks.scoped.status === "unavailable" || locks.scoped.admission_locked ||
        locks.scoped.scope_bridge || locks.scoped.lease_count !== 0 || locks.scoped.unknown_count !== 0)) {
      return { error: "MCP_SCOPED_LEASES_PRESENT_OR_UNKNOWN" };
    }
    if (locks.active?.record?.type === "scope_bridge") return { error: "MCP_SCOPED_LEASES_PRESENT_OR_UNKNOWN" };
    if (locks.active?.record?.state === "unknown") return { error: "MCP_UNKNOWN_LOCK_PRESENT" };
    if (locks.active) return { error: "MCP_ACTIVE_LOCK_PRESENT" };
    return { locks };
  } catch {
    return { error: "MCP_LOCK_INSPECTION_FAILED" };
  }
}

async function readState(driver) {
  try { return await driver.readState(); }
  catch { return null; }
}

async function readMonitoredState(driver, expectedProcesses) {
  if (typeof driver.readMonitorState !== "function") return readState(driver);
  try { return await driver.readMonitorState(expectedProcesses); }
  catch { return null; }
}

const defaultInspectLocks = () => inspectRecovery(
  pathsAdapter().taskDirectory({ env: process.env, home: os.homedir() }));

export async function checkMcp(options = {}) {
  const session = options.driver ? null : new PowerShellSession();
  const {
    driver = defaultControlDriver(session),
    inspectLocks = defaultInspectLocks,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
    stabilitySamples = 1,
    pollIntervalMs = 500,
  } = options;
  try {
    try {
      let previous = null;
      let stable = 0;
      let details = {};
      for (let sample = 0; sample < stabilitySamples; sample++) {
        const pollStarted = now();
        const state = await readState(driver);
        const checked = state ? classifyState(state) : { error: "MCP_WINDOWS_QUERY_FAILED" };
        details = classificationDetails(checked);
        const lockState = await readLocks(inspectLocks);
        if (lockState.error) return { ok: false, code: lockState.error, processCheck: checked.error || checked.kind || "passed", ...details };
        if (checked.error) return { ok: false, code: checked.error, ...details };
        if (checked.kind !== "running") return { ok: false, code: checked.kind === "orphan" ? "MCP_ORPHANED_PROCESSES" : "MCP_TASK_NOT_RUNNING", ...details };
        stable = checked.signature === previous ? stable + 1 : 1;
        previous = checked.signature;
        if (sample + 1 < stabilitySamples) await waitForNextPoll(now, sleep, pollIntervalMs, pollStarted);
      }
      return stable >= stabilitySamples
        ? { ok: true, ...details }
        : { ok: false, code: "MCP_PROCESS_NOT_STABLE", ...details };
    } finally {
      await session?.close();
    }
  } catch { return { ok: false, code: "MCP_CONTROL_FAILED", phase: "unknown" }; }
}

async function waitForCleanReady(driver, {
  now, sleep, timeoutMs, pollIntervalMs, initialProcesses = [], cleanupOrphan = false,
  inspectLocks,
} = {}) {
  const deadline = now() + timeoutMs;
  const oldIds = new Set(initialProcesses.map(processIdentity));
  let cleanupStarted = false;
  let lastCode = "MCP_TASK_STOP_TIMEOUT";
  let details = {};
  do {
    const pollStarted = now();
    const state = await readMonitoredState(driver, initialProcesses);
    if (!state) return { error: "MCP_WINDOWS_QUERY_FAILED" };
    const checked = classifyState(state);
    details = classificationDetails(checked);
    if (checked.kind === "ready") {
      return { ok: true, taskName: checked.taskName };
    } else {
      lastCode = checked.error || "MCP_PROCESS_NOT_STOPPED";
      if (checked.kind === "orphan" && cleanupOrphan && !cleanupStarted) {
        const cleanup = await (async () => {
          if (checked.processes.some(process => !oldIds.has(processIdentity(process)))) {
            return { error: "MCP_ORPHAN_PROCESS_IDENTITY_CHANGED" };
          }
          const lockState = await readLocks(inspectLocks || defaultInspectLocks);
          if (lockState.error) return { error: lockState.error, phase: "before-start" };
          if (typeof driver.stopOrphans !== "function") return { error: "MCP_ORPHAN_CLEANUP_UNAVAILABLE" };
          try {
            await driver.stopOrphans(state.task.name, checked.processes);
            cleanupStarted = true;
            return { ok: true };
          } catch {
            return { error: "MCP_ORPHAN_CLEANUP_FAILED" };
          }
        })();
        if (cleanup.error) return cleanup;
      }
    }
    if (now() >= deadline) break;
    await waitForNextPoll(now, sleep, pollIntervalMs, pollStarted);
  } while (true);
  return { error: "MCP_TASK_STOP_TIMEOUT", lastCode, ...details };
}

function orphanStopScript(taskName, processes) {
  const expected = processes.map(process => ({
    role: process.desktopCommander ? "desktopCommander" : process.mcp ? "mcp" : "tunnel",
    pid: process.pid,
    parentPid: process.parentPid,
    startedAt: process.startedAt,
    executablePath: process.executablePath,
    commandHash: process.commandHash,
    name: process.name,
  }));
  const encoded = JSON.stringify(expected);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$expected = ConvertFrom-Json -InputObject " + psLiteral(encoded),
    "$expectedName = " + psLiteral(taskName),
    "$launcher = " + psLiteral(LAUNCHER),
    "$entrypoint = " + psLiteral(ENTRYPOINT),
    "$commanderEntrypoint = " + psLiteral(COMMANDER_ENTRYPOINT),
    "$nodeExecutable = " + psLiteral(NODE_EXECUTABLE),
    "$launcherArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $launcher + '\"'",
    "$launcherArgsUnquoted = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $launcher",
    "$launcherInvocationPattern = '(?i)(?:^|\\s)-File\\s+(?:\"' + [regex]::Escape($launcher) + '\"|' + [regex]::Escape($launcher) + ')(?:\\s|$)'",
    "$taskNames = @(" + TASK_NAMES.map(psLiteral).join(",") + ")",
    scheduledTaskQueryScript(),
    "if ($tasks.Count -ne 1 -or [string]$tasks[0].TaskName -cne $expectedName -or [string]$tasks[0].State -cne 'Ready') { throw 'MCP_TASK_CHANGED' }",
    "$task = $tasks[0]; $actions = @($task.Actions)",
    "if ($actions.Count -ne 1 -or (![string]::Equals([string]$actions[0].Execute, 'powershell.exe', [StringComparison]::OrdinalIgnoreCase) -and ![string]::Equals([IO.Path]::GetFullPath([string]$actions[0].Execute), [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')), [StringComparison]::OrdinalIgnoreCase))) { throw 'MCP_TASK_ACTION_CHANGED' }",
    "$actionArgs = ([string]$actions[0].Arguments).Trim()",
    "if (![string]::Equals($actionArgs, $launcherArgs, [StringComparison]::OrdinalIgnoreCase) -and ![string]::Equals($actionArgs, $launcherArgsUnquoted, [StringComparison]::OrdinalIgnoreCase)) { throw 'MCP_TASK_ACTION_CHANGED' }",
    "$launcherText = Get-Content -LiteralPath $launcher -Raw -ErrorAction Stop",
    "$tunnelMatch = [regex]::Match($launcherText, '(?im)^\\s*\\$tunnel\\s*=\\s*\"([^\"]+)\"\\s*$')",
    "if (!$tunnelMatch.Success) { throw 'MCP_LAUNCHER_CONFIGURATION_INVALID' }",
    "$tunnelPath = [IO.Path]::GetFullPath($tunnelMatch.Groups[1].Value)",
    "$listeners = @(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction Stop)",
    "$tunnelRows = @($expected | Where-Object { $_.role -eq 'tunnel' })",
    "$mcpRows = @($expected | Where-Object { $_.role -eq 'mcp' })",
    "$commanderRows = @($expected | Where-Object { $_.role -eq 'desktopCommander' })",
    "if ($expected.Count -ne 3 -or $tunnelRows.Count -ne 1 -or $mcpRows.Count -ne 1 -or $commanderRows.Count -ne 1) { throw 'MCP_ORPHAN_PROCESS_SET_INVALID' }",
    "if ($listeners.Count -eq 0 -or [int]$mcpRows[0].parentPid -ne [int]$tunnelRows[0].pid -or [int]$commanderRows[0].parentPid -ne [int]$mcpRows[0].pid -or @($listeners | Where-Object { [int]$_.OwningProcess -ne [int]$tunnelRows[0].pid }).Count -gt 0) { throw 'MCP_ORPHAN_OWNER_CHANGED' }",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$launcherPresent = @($all | Where-Object { $_.Name -ieq 'powershell.exe' -and ([string]$_.CommandLine).Replace('/', '\\') -match $launcherInvocationPattern })",
    "if ($launcherPresent.Count -gt 0) { throw 'MCP_ORPHAN_LAUNCHER_PRESENT' }",
    "$tunnelCandidates = @($all | Where-Object { $_.Name -ieq [IO.Path]::GetFileName($tunnelPath) })",
    "$mcpCandidates = @($all | Where-Object { $_.Name -ieq 'node.exe' -and ([string]$_.CommandLine).Replace('/', '\\').IndexOf($entrypoint.Replace('/', '\\'), [StringComparison]::OrdinalIgnoreCase) -ge 0 })",
    "$commanderCandidates = @($all | Where-Object { $_.Name -ieq 'node.exe' -and ([string]$_.CommandLine).Replace('/', '\\').IndexOf($commanderEntrypoint.Replace('/', '\\'), [StringComparison]::OrdinalIgnoreCase) -ge 0 })",
    "if ($tunnelCandidates.Count -ne 1 -or $mcpCandidates.Count -ne 1 -or $commanderCandidates.Count -ne 1 -or [string]$tunnelCandidates[0].ExecutablePath -ine [string]$tunnelRows[0].executablePath -or [string]$tunnelRows[0].executablePath -ine $tunnelPath) { throw 'MCP_ORPHAN_OWNER_CHANGED' }",
    "if (@($all | Where-Object { [int]$_.ProcessId -eq [int]$tunnelRows[0].parentPid }).Count -gt 0) { throw 'MCP_ORPHAN_PARENT_PRESENT' }",
    "$handles = @{}",
    "foreach ($item in $expected) {",
    "  $rows = @($all | Where-Object { [int]$_.ProcessId -eq [int]$item.pid })",
    "  if ($rows.Count -ne 1) { throw 'MCP_ORPHAN_IDENTITY_CHANGED' }",
    "  $row = $rows[0]",
    "  $command = ([string]$row.CommandLine).Replace('/', '\\')",
    "  $sha = [Security.Cryptography.SHA256]::Create()",
    "  try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($command))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }",
    "  if ([string]$row.ExecutablePath -ine [string]$item.executablePath -or $hash -cne [string]$item.commandHash -or [int]$row.ParentProcessId -ne [int]$item.parentPid -or $row.CreationDate.ToUniversalTime().ToString('o') -cne [string]$item.startedAt) { throw 'MCP_ORPHAN_IDENTITY_CHANGED' }",
    "  $handle = Get-Process -Id ([int]$item.pid) -ErrorAction Stop",
    "  $expectedStart = [DateTime]::Parse([string]$item.startedAt).ToUniversalTime()",
    "  if ([string]$handle.Path -ine [string]$item.executablePath -or [Math]::Abs(($handle.StartTime.ToUniversalTime() - $expectedStart).TotalMilliseconds) -gt 1000) { throw 'MCP_ORPHAN_PID_REUSED' }",
    "  $handles[[string]$item.role] = $handle",
    "}",
    "foreach ($role in @('desktopCommander', 'mcp', 'tunnel')) {",
    "  $handle = $handles[$role]",
    "  if (!$handle) { throw 'MCP_ORPHAN_IDENTITY_CHANGED' }",
    "  $handle.Kill()",
    "  if (!$handle.WaitForExit(5000)) { throw 'MCP_ORPHAN_STOP_UNCONFIRMED' }",
    "}",
  ].join("\n");
  return script;
}

async function stopOrphanProcesses(taskName, processes, session) {
  if (process.platform !== "win32") throw Object.assign(new Error(), { code: "MCP_WINDOWS_ONLY" });
  await invokePowerShell(orphanStopScript(taskName, processes), "MCP_ORPHAN_CLEANUP_FAILED", session);
}

function defaultControlDriver(session) {
  return {
    readState: () => readWindowsState(session),
    readMonitorState: (processes) => readWindowsMonitorState(processes, session),
    stop: (taskName) => changeScheduledTask("stop", taskName, session),
    start: (taskName) => changeScheduledTask("start", taskName, session),
    stopOrphans: (taskName, processes) => stopOrphanProcesses(taskName, processes, session),
  };
}

async function confirmStartedTask({
  driver, inspectLocks, now, sleep, pollIntervalMs, startTimeoutMs, stableSamples,
  expectedTaskName,
}) {
  const startDeadline = now() + startTimeoutMs;
  let previous = null;
  let stable = 0;
  let lastError = "MCP_TASK_NOT_RUNNING";
  let checked = { error: "MCP_TASK_NOT_RUNNING" };
  let monitorProcesses = null;
  do {
    const pollStarted = now();
    const lockState = await readLocks(inspectLocks);
    if (lockState.error) return { ok: false, code: lockState.error, phase: "post-check", taskMayHaveChanged: true };
    const state = monitorProcesses
      ? await readMonitoredState(driver, monitorProcesses)
      : await readState(driver);
    if (!state) return { ok: false, code: "MCP_WINDOWS_QUERY_FAILED", phase: "post-check", taskMayHaveChanged: true };
    checked = classifyState(state);
    if (checked.kind !== "running" || checked.taskName !== expectedTaskName) {
      lastError = checked.error || (checked.kind === "orphan" ? "MCP_ORPHANED_PROCESSES" :
        checked.kind === "running" ? "MCP_TASK_IDENTITY_CHANGED" : "MCP_TASK_NOT_RUNNING");
      previous = null;
      stable = 0;
      monitorProcesses = null;
    } else {
      stable = checked.signature === previous ? stable + 1 : 1;
      previous = checked.signature;
      monitorProcesses = checked.processes;
      if (stable >= stableSamples) return { ok: true, ...classificationDetails(checked) };
    }
    if (now() >= startDeadline) break;
    await waitForNextPoll(now, sleep, pollIntervalMs, pollStarted);
  } while (true);
  return { ok: false, code: "MCP_RESTART_READINESS_TIMEOUT", lastCode: lastError,
    phase: "post-check", taskMayHaveChanged: true, ...classificationDetails(checked) };
}

async function restartCore(options) {
  const {
    driver = defaultControlDriver(),
    inspectLocks = defaultInspectLocks,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
    pollIntervalMs = 500,
    stopTimeoutMs = 30000,
    startTimeoutMs = 45000,
    stableSamples = 2,
  } = options;

  let lockState = await readLocks(inspectLocks);
  if (lockState.error) return { ok: false, code: lockState.error, phase: "preflight" };
  let state = await readState(driver);
  if (!state) return { ok: false, code: "MCP_WINDOWS_QUERY_FAILED", phase: "preflight" };
  let checked = classifyState(state);
  if (checked.error) return { ok: false, code: checked.error, phase: "preflight", ...classificationDetails(checked) };
  const initiallyReady = checked.kind === "ready";
  let expectedTaskName = state.task.name;
  if (checked.kind === "running") {
    lockState = await readLocks(inspectLocks);
    if (lockState.error) return { ok: false, code: lockState.error, phase: "preflight" };
    state = await readState(driver);
    if (!state) return { ok: false, code: "MCP_WINDOWS_QUERY_FAILED", phase: "preflight" };
    const beforeStop = classifyState(state);
    if (beforeStop.kind !== "running" || beforeStop.taskName !== checked.taskName ||
        beforeStop.signature !== checked.signature) {
      return { ok: false, code: beforeStop.error || "MCP_PROCESS_IDENTITY_CHANGED", phase: "preflight", ...classificationDetails(beforeStop) };
    }
    try {
      await driver.stop(checked.taskName);
    } catch {
      return { ok: false, code: "MCP_TASK_STOP_FAILED", phase: "stopping", taskMayHaveChanged: true };
    }
    const stopped = await waitForCleanReady(driver, {
      now, sleep, timeoutMs: stopTimeoutMs, pollIntervalMs,
      initialProcesses: checked.processes, cleanupOrphan: true,
      inspectLocks,
    });
    if (stopped.error) {
      return { ok: false, code: stopped.error, ...(stopped.lastCode ? { lastCode: stopped.lastCode } : {}),
        phase: stopped.phase || "stopping", taskMayHaveChanged: true, ...classificationDetails(stopped) };
    }
    if (stopped.taskName !== expectedTaskName) {
      return { ok: false, code: "MCP_TASK_IDENTITY_CHANGED", phase: "stopping", taskMayHaveChanged: true };
    }
  } else if (checked.kind === "orphan") {
    lockState = await readLocks(inspectLocks);
    if (lockState.error) return { ok: false, code: lockState.error, phase: "preflight" };
    if (typeof driver.stopOrphans !== "function") {
      return { ok: false, code: "MCP_ORPHAN_CLEANUP_UNAVAILABLE", phase: "preflight" };
    }
    try {
      await driver.stopOrphans(state.task.name, checked.processes);
    } catch {
      return { ok: false, code: "MCP_ORPHAN_CLEANUP_FAILED", phase: "stopping", taskMayHaveChanged: true };
    }
    const stopped = await waitForCleanReady(driver, {
      now, sleep, timeoutMs: stopTimeoutMs, pollIntervalMs,
      initialProcesses: checked.processes, cleanupOrphan: false,
      inspectLocks,
    });
    if (stopped.error) {
      return { ok: false, code: stopped.error, ...(stopped.lastCode ? { lastCode: stopped.lastCode } : {}),
        phase: stopped.phase || "stopping", taskMayHaveChanged: true, ...classificationDetails(stopped) };
    }
    if (stopped.taskName !== expectedTaskName) {
      return { ok: false, code: "MCP_TASK_IDENTITY_CHANGED", phase: "stopping", taskMayHaveChanged: true };
    }
  }

  const beforeStart = await (async () => {
    lockState = await readLocks(inspectLocks);
    if (lockState.error) return { error: lockState.error };
    state = await readState(driver);
    if (!state) return { error: "MCP_WINDOWS_QUERY_FAILED" };
    checked = classifyState(state);
    const checkedDetails = classificationDetails(checked);
    if (checked.kind !== "ready" || checked.taskName !== expectedTaskName) {
      return { error: checked.error || (checked.kind === "ready" ? "MCP_TASK_IDENTITY_CHANGED" : "MCP_PROCESS_NOT_STOPPED"),
        ...checkedDetails };
    }
    lockState = await readLocks(inspectLocks);
    if (lockState.error) return { error: lockState.error };
    return { ok: true, taskName: state.task.name };
  })();
  if (beforeStart.error) return { ok: false, code: beforeStart.error, phase: "before-start",
    taskMayHaveChanged: !initiallyReady,
    ...classificationDetails(beforeStart) };
  try {
    await driver.start(beforeStart.taskName);
  } catch {
    return { ok: false, code: "MCP_TASK_START_FAILED", phase: "starting", taskMayHaveChanged: true };
  }
  return confirmStartedTask({
    driver, inspectLocks, now, sleep, pollIntervalMs, startTimeoutMs, stableSamples,
    expectedTaskName: beforeStart.taskName,
  });
}

export async function restartMcp(options = {}) {
  const session = options.driver ? null : new PowerShellSession();
  const runOptions = options.driver ? options : { ...options, driver: defaultControlDriver(session) };
  try {
    return await restartCore(runOptions);
  } catch { return { ok: false, code: "MCP_CONTROL_FAILED", phase: "unknown" }; }
  finally { await session?.close(); }
}

function formatProcessDetails(result, language = "en") {
  const lines = [];
  for (const item of result.processDiagnostics || []) {
    const process = processSummary(item);
    // Do not serialize arbitrary driver rows, paths, or command text into diagnostics.
    const fields = (item.missing || []).filter(field => ["ProcessId", "ParentProcessId", "CreationDate", "ExecutablePath", "CommandLine fingerprint"].includes(field));
    const detail = fields.length ? translate(language, "mcp.process.missing", { fields: fields.map(field => `    - ${field}`).join("\n") })
      : translate(language, item.invalidRole ? "mcp.process.ambiguous" : "mcp.process.identityMismatch");
    lines.push(translate(language, "mcp.process.detail", { pid: process.pid ?? "unknown", name: process.name, detail }));
  }
  if (result.additionalProcesses?.length) {
    const processes = result.additionalProcesses.map(item => {
      const process = processSummary(item);
      return `PID ${process.pid ?? "unknown"} (${process.name})`;
    }).join(", ");
    lines.push(translate(language, "mcp.process.additional", { processes }));
  }
  return lines;
}

export function formatFailure(mode, result, language = "en") {
  const label = translate(language, mode === "restart" ? "mcp.label.restart" : "mcp.label.check");
  const lines = [translate(language, "mcp.failure.prefix", { label, code: result.code })];
  if (result.lastCode) lines.push(translate(language, "mcp.failure.lastCheck", { code: result.lastCode }));
  lines.push(...formatProcessDetails(result, language));
  const identityUnavailable = result.processDiagnostics?.some(item => item.missing?.includes("ExecutablePath") || item.missing?.includes("CommandLine fingerprint"));
  if (identityUnavailable) {
    lines.push(translate(language, "mcp.failure.identityFields"));
  }
  if (mode === "check") {
    if (!identityUnavailable) lines.push(translate(language, "mcp.failure.checkNoChange"));
    if (result.processCheck) lines.push(translate(language, "mcp.failure.localCheck", { code: result.processCheck }));
  } else if (result.phase === "preflight") {
    lines.push(translate(language, identityUnavailable ? "mcp.failure.preflightIdentity" : "mcp.failure.preflight"));
  } else if (result.phase === "stopping") {
    lines.push(translate(language, "mcp.failure.stopping"));
  } else if (result.phase === "before-start") {
    lines.push(translate(language, "mcp.failure.beforeStart"));
  } else {
    lines.push(translate(language, "mcp.failure.unknownState"));
  }
  return lines.join("\n");
}

async function main() {
  const mode = process.argv[2];
  let language = "en";
  let args;
  try {
    const parsed = parseLanguageFlags(process.argv.slice(3));
    args = parsed.args;
    language = (await resolveLanguagePreference({ explicitLanguage: parsed.explicitLanguage })).language;
  } catch (error) {
    language = (await resolveLanguagePreference().catch(() => ({ language: "en" }))).language;
    console.error(formatLanguageError(error, language));
    process.exitCode = 2;
    return;
  }
  if (!new Set(["check", "restart"]).has(mode) || args.length !== 0) {
    console.error(translate(language, "cli.usage.mcpControl"));
    process.exitCode = 2;
    return;
  }
  if (process.platform !== "win32") {
    console.error(formatFailure(mode, { code: "MCP_WINDOWS_ONLY", phase: "preflight" }, language));
    process.exitCode = 1;
    return;
  }
  const progressKey = mode === "check" ? "mcp.progress.check"
    : "mcp.progress.restart";
  const result = await withSpinner(translate(language, progressKey), () => mode === "check" ? checkMcp()
    : restartMcp(), { stream: process.stderr, env: process.env });
  if (!result.ok) {
    console.error(formatFailure(mode, result, language));
    process.exitCode = 1;
    return;
  }
  console.log(translate(language, mode === "check" ? "mcp.success.check" : "mcp.success.restart"));
  for (const line of formatProcessDetails(result, language)) console.log(line);
  if (mode === "check") console.log(translate(language, "mcp.failure.remoteHealth"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main().catch(async () => {
    const { language } = await resolveLanguagePreference().catch(() => ({ language: "en" }));
    console.error(translate(language, "mcp.control.failed"));
    process.exitCode = 1;
  });
}
