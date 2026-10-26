import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { PowerShellSession } from "../scripts/powershell-session.mjs";
import { checkMcp, formatFailure, restartMcp, readStateScript, readMonitorStateScript, taskActionScript } from "../scripts/mcp-control.mjs";
import { failure as recoveryFailure, previewGit, runGuidedRecovery } from "../scripts/recover-guided.mjs";
import { formatLanguageError, getConfigPath, getSavedLanguage, languageFromLocale, parseLanguageFlags, resolveLanguagePreference, saveLanguage, translate, validateLanguage, validateLocaleCatalogs } from "../src/i18n/index.mjs";
import { probeProcesses } from "../src/mcp/execution-guard.mjs";
import { terminateOwnedProcessTree } from "../src/runtime/foreground.mjs";

const checks = [];
const NEW_TASK = "ThriftyRelay MCP";
const makeProcess = (pid, parentPid, role, flags = {}) => {
  const roleFlags = {
    launcher: { launcherCandidate: true, launcher: true, roles: ["launcher"], name: "powershell.exe" },
    tunnel: { tunnelCandidate: true, tunnel: true, roles: ["tunnel"], name: "tunnel-client.exe" },
    mcp: { mcpCandidate: true, mcp: true, roles: ["mcp"], name: "node.exe" },
    desktopCommander: { commanderCandidate: true, desktopCommander: true, roles: ["desktopCommander"], name: "node.exe" },
  }[role] || { roles: ["other"], name: role };
  return {
    pid, parentPid, startedAt: new Date(pid * 1000).toISOString(),
    executablePath: role === "launcher" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : role === "tunnel" ? "C:\\Home\\tunnel-client.exe" : "C:\\Program Files\\nodejs\\node.exe",
    commandHash: String(pid).padStart(64, "a").slice(-64),
    parentExists: parentPid > 0,
    launcherCandidate: false, tunnelCandidate: false, mcpCandidate: false, commanderCandidate: false,
    launcher: false, tunnel: false, mcp: false, desktopCommander: false,
    ...roleFlags, ...flags,
  };
};
const taskInfo = (state, name = NEW_TASK) => ({
  count: 1, name, path: "\\", state, actionCount: 1, actionValid: true,
});
const readyState = (name = NEW_TASK) => ({
  task: taskInfo("Ready", name), processes: [], listeners: [], listenerQueryValid: true,
});
const healthyState = (base = 100, name = NEW_TASK) => {
  const launcher = makeProcess(base, 10, "launcher");
  const tunnel = makeProcess(base + 1, base, "tunnel");
  const mcp = makeProcess(base + 2, base + 1, "mcp");
  const commander = makeProcess(base + 3, base + 2, "desktopCommander");
  return {
    task: taskInfo("Running", name), processes: [launcher, tunnel, mcp, commander],
    listeners: [{ pid: tunnel.pid, address: "127.0.0.1" }], listenerQueryValid: true,
  };
};
const orphanState = (base = 200, name = NEW_TASK) => {
  const tunnel = makeProcess(base, 999, "tunnel", { parentExists: false });
  const mcp = makeProcess(base + 1, base, "mcp");
  const commander = makeProcess(base + 2, base + 1, "desktopCommander");
  return {
    task: taskInfo("Ready", name), processes: [tunnel, mcp, commander],
    listeners: [{ pid: tunnel.pid, address: "127.0.0.1" }], listenerQueryValid: true,
  };
};
const noLocks = async () => ({ active: null, maintenance: null });

const withAdditionalProcesses = state => ({ ...state, processes: [
  ...state.processes,
  makeProcess(1001, state.processes[0]?.pid || 999, "conhost.exe"),
  makeProcess(1002, state.processes[1]?.pid || 999, "conhost.exe", { commandHash: null, executablePath: "" }),
  makeProcess(1003, state.processes[1]?.pid || 999, "codex.exe"),
  makeProcess(1004, state.processes.at(-1)?.pid || 999, "conhost.exe"),
] });

{
  let reads = 0;
  const result = await checkMcp({
    driver: { readState: async () => { reads++; return healthyState(); } },
    inspectLocks: noLocks, sleep: async () => assert.fail("point-in-time check must not wait"),
  });
  assert.equal(result.ok, true);
  assert.equal(reads, 1);
  checks.push("default-check-reports-current-state-without-stability-waits");
}

{
  for (const queryMs of [200, 800]) {
    let clock = 0;
    const starts = [], delays = [];
    const result = await checkMcp({
      driver: { readState: async () => { starts.push(clock); clock += queryMs; return healthyState(); } },
      inspectLocks: noLocks, stabilitySamples: 3, pollIntervalMs: 500, now: () => clock,
      sleep: async ms => { delays.push(ms); clock += ms; },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(starts, queryMs === 200 ? [0, 500, 1000] : [0, 800, 1600]);
    assert.deepEqual(delays, queryMs === 200 ? [300, 300] : []);
  }
  checks.push("poll-spacing-includes-query-time-without-an-extra-full-interval");
}

if (process.platform === "win32") {
  // Exercise the production PowerShell reader with fixture-only OS queries.
  const root = path.resolve(import.meta.dirname, "..");
  const launcher = path.join(process.env.LOCALAPPDATA, "ThriftyRelay", "Start-ThriftyRelay.ps1");
  const entrypoint = path.join(root, "index.mjs");
  const commander = path.join(root, "node_modules", "@wonderwhy-er", "desktop-commander", "dist", "index.js");
  const psExe = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tunnel = "C:\\Fixture\\tunnel-client.exe";
  const args = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcher}"`;
  const rows = [
    [100, 10, "powershell.exe", psExe, `"${psExe}" ${args}`],
    [101, 100, "tunnel-client.exe", tunnel, `"${tunnel}" run --mcp.command "node ${entrypoint}" --health.listen-addr "127.0.0.1:8080"`],
    [102, 101, "node.exe", process.execPath, `node ${entrypoint}`],
    [103, 102, "node.exe", process.execPath, `"${process.execPath}" "${commander}"`],
    [104, 100, "conhost.exe", "C:\\Windows\\System32\\conhost.exe", "conhost.exe"],
    [105, 101, "conhost.exe", "", ""],
    [106, 101, "codex.exe", "C:\\Fixture\\codex.exe", "codex.exe secret-command-text"],
    [107, 103, "conhost.exe", "C:\\Windows\\System32\\conhost.exe", "conhost.exe"],
  ].map(([ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine]) => ({
    ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate: new Date(ProcessId * 1000).toISOString(),
  }));
  const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
  const prelude = fixtureRows => [
    "$ProgressPreference = 'SilentlyContinue'",
    "$fixtureRows = ConvertFrom-Json " + literal(JSON.stringify(fixtureRows)),
    "foreach ($row in $fixtureRows) { $row.CreationDate = [DateTime]::Parse($row.CreationDate) }",
    "$fixtureArgs = " + literal(args),
    "$fixtureLauncherText = " + literal(`$tunnel = "${tunnel}"\n$mcpCommand = "node ${entrypoint}"\n$healthAddress = "127.0.0.1:8080"`),
    "$script:fixtureStopped = 0; $script:fixtureStarted = 0",
    "$fixtureTask = [pscustomobject]@{ Name = 'ThriftyRelay MCP'; Path = '\\ThriftyRelay MCP'; State = 4; Definition = [pscustomobject]@{ Actions = @([pscustomobject]@{ Type = 0; Path = 'powershell.exe'; Arguments = $fixtureArgs }) } }",
    "$fixtureTask | Add-Member ScriptMethod Stop { param($flags) if ($flags -ne 0) { throw 'FIXTURE_STOP_FLAGS_INVALID' }; $script:fixtureStopped++ }",
    "$fixtureTask | Add-Member ScriptMethod Run { param($parameters) if ($null -ne $parameters) { throw 'FIXTURE_RUN_PARAMETERS_INVALID' }; $script:fixtureStarted++; return [pscustomobject]@{ InstanceGuid = 'fixture' } }",
    "$script:fixtureTasks = @($fixtureTask)",
    "$fixtureFolder = [pscustomobject]@{}",
    "$fixtureFolder | Add-Member ScriptMethod GetTasks { param($flags) if ($flags -ne 1) { throw 'FIXTURE_HIDDEN_TASKS_EXCLUDED' }; return $script:fixtureTasks }",
    "$fixtureScheduler = [pscustomobject]@{}",
    "$fixtureScheduler | Add-Member ScriptMethod Connect {}",
    "$fixtureScheduler | Add-Member ScriptMethod GetFolder { param($path) if ($path -cne '\\') { throw 'FIXTURE_TASK_FOLDER_INVALID' }; return $fixtureFolder }",
    "function New-Object { param($TypeName, $ComObject) if ($ComObject -eq 'Schedule.Service') { return $fixtureScheduler }; Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName }",
    "function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return $fixtureRows }",
    "function Test-Path { param($LiteralPath, $PathType) return $true }",
    "function Get-Content { param($LiteralPath, [switch]$Raw, $ErrorAction) return $fixtureLauncherText }",
    "function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) return [pscustomobject]@{OwningProcess=101; LocalAddress='127.0.0.1'} }",
  ].join("\n");
  const fixtureSession = new PowerShellSession();
  const runFixture = async script => JSON.parse(await fixtureSession.run(script, "MCP_TEST_FIXTURE_FAILED"));
  try {
    const state = await runFixture(prelude(rows) + "\n" + readStateScript());
    const monitorScript = readMonitorStateScript(state.processes.filter(row => row.roles[0] !== "other"));
    const monitored = await runFixture(prelude(rows) + "\n" + monitorScript);
    assert.equal(state.processes.length, 8);
    assert.match(monitorScript, /Get-CimInstance Win32_Process -Filter/);
    assert(!monitorScript.includes("Get-CimInstance Win32_Process -ErrorAction Stop"));
    assert.equal(monitored.processes.length, state.processes.length);
    assert.equal(monitored.task.state, state.task.state);
    assert.equal(monitored.listeners[0].pid, state.listeners[0].pid);
    assert.equal(state.processes.filter(row => row.roles[0] !== "other").length, 4);
    assert(!JSON.stringify(state).includes("secret-command-text"));
    const result = await checkMcp({ driver: { readState: async () => state }, inspectLocks: noLocks, stabilitySamples: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.additionalProcesses.length, 4);
    const unavailable = await runFixture(prelude(rows.map(row => ({ ...row, ExecutablePath: "", CommandLine: "" }))) + "\n" + readStateScript());
    const failed = await checkMcp({ driver: { readState: async () => unavailable }, inspectLocks: noLocks, stabilitySamples: 1 });
    assert.equal(failed.code, "MCP_PROCESS_IDENTITY_UNAVAILABLE");
    assert.deepEqual(failed.processDiagnostics[0], { pid: 101, name: "tunnel-client.exe", missing: ["ExecutablePath", "CommandLine fingerprint"] });
    assert.equal(unavailable.processes.length, 6, "unreadable descendants are observed without inferring managed roles");
    checks.push("windows-full-and-filtered-readers-preserve-managed-and-descendant-process-evidence");

    for (const [name, setup, operation, expected] of [
      ["stop", "", "stop", { failed: false, stops: 1, starts: 0 }],
      ["start", "$fixtureTask.State = 3", "start", { failed: false, stops: 0, starts: 1 }],
      ["two-names", "$script:fixtureTasks += [pscustomobject]@{ Name = 'ThriftyRelay MCP'; Path = '\\ThriftyRelay MCP'; State = 4; Definition = $fixtureTask.Definition }", "stop"],
      ["wrong-folder", "$fixtureTask.Path = '\\Other\\ThriftyRelay MCP'", "stop"],
      ["wrong-state", "$fixtureTask.State = 3", "stop"],
      ["unknown-state", "$fixtureTask.State = 0", "stop"],
      ["non-exec-action", "$fixtureTask.Definition.Actions[0].Type = 5", "stop"],
      ["changed-arguments", "$fixtureTask.Definition.Actions[0].Arguments = 'different'", "stop"],
      ["multiple-actions", "$fixtureTask.Definition.Actions += $fixtureTask.Definition.Actions[0]", "stop"],
      ["query-failure", "$fixtureFolder | Add-Member ScriptMethod GetTasks { throw 'FIXTURE_ACCESS_DENIED' } -Force", "stop"],
    ]) {
      const source = prelude(rows) + "\n" + setup + "\n$failed = $false\ntry {\n" +
        taskActionScript(NEW_TASK, operation === "stop" ? "Running" : "Ready", operation) +
        "\n} catch { $failed = $true }\n[pscustomobject]@{ failed = $failed; stops = $script:fixtureStopped; starts = $script:fixtureStarted } | ConvertTo-Json -Compress";
      assert.deepEqual(await runFixture(source), expected || { failed: true, stops: 0, starts: 0 }, name);
    }
    checks.push("task-scheduler-api-checks-hidden-tasks-state-folder-actions-and-query-errors-before-control");

  } finally { await fixtureSession.close(); }
}

{
  let reads = 0;
  const result = await checkMcp({
    driver: { readState: async () => {
      const state = withAdditionalProcesses(healthyState());
      // Auxiliary lifetimes and inaccessible fields must not destabilize managed identity.
      state.processes.at(-1).pid += reads++;
      return state;
    } },
    inspectLocks: noLocks, sleep: async () => {}, stabilitySamples: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.additionalProcesses.length, 4);
  checks.push("eight-process-tree-allows-additional-consoles-and-codex-without-identity-requirements");
}

{
  for (const initial of ["running", "ready", "orphan"]) {
    let phase = initial, stops = 0, orphanStops = 0, starts = 0;
    const driver = {
      readState: async () => withAdditionalProcesses(phase === "running" ? healthyState()
        : phase === "orphan" ? orphanState() : phase === "started" ? healthyState(400) : readyState()),
      stop: async () => { stops++; phase = "orphan"; },
      stopOrphans: async (_name, processes) => {
        assert.deepEqual(processes.map(process => process.pid), phase === "orphan" && initial === "running" ? [103, 102, 101] : [202, 201, 200]);
        assert(processes.every(process => process.roles[0] !== "other"));
        orphanStops++; phase = "ready";
      },
      start: async () => { starts++; phase = "started"; },
    };
    // Preserve the original managed identities after stopping a Running task.
    const read = driver.readState;
    driver.readState = async () => phase === "orphan" && initial === "running"
      ? withAdditionalProcesses(orphanState(101)) : read();
    const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0, stableSamples: 2 });
    assert.equal(result.ok, true, initial);
    assert.equal(stops, initial === "running" ? 1 : 0);
    assert.equal(orphanStops, initial === "ready" ? 0 : 1);
    assert.equal(starts, 1);
  }
  checks.push("running-ready-and-orphan-restarts-never-pass-additional-processes-to-cleanup");
}

{
  const state = healthyState();
  state.processes[1].executablePath = "";
  state.processes[1].commandHash = null;
  state.processes[1].commandLine = "secret-command-text";
  let stops = 0, starts = 0;
  const driver = { readState: async () => state, stop: async () => { stops++; }, start: async () => { starts++; } };
  for (const result of [await checkMcp({ driver, inspectLocks: noLocks }), await restartMcp({ driver, inspectLocks: noLocks })]) {
    assert.equal(result.code, "MCP_PROCESS_IDENTITY_UNAVAILABLE");
    assert.deepEqual(result.processDiagnostics, [{ pid: 101, name: "tunnel-client.exe", missing: ["ExecutablePath", "CommandLine fingerprint"] }]);
    const text = formatFailure("check", result);
    assert.match(text, /PID 101 \(tunnel-client.exe\)\n  Unavailable fields:\n    - ExecutablePath\n    - CommandLine fingerprint/);
    assert.match(text, /elevated PowerShell/);
    assert.match(text, /thriftyrelay mcp check/);
    assert(!text.includes("Task Scheduler"));
    assert(!text.includes("health tool"), "failed checks must not show the success-only health instruction");
    for (const mode of ["restart"]) {
      const guidance = formatFailure(mode, { ...result, phase: "preflight" });
      assert.match(guidance, /thriftyrelay mcp check/);
      assert(!guidance.includes("Task Scheduler"));
      assert(!guidance.includes("lock or task state"));
    }
    assert(!JSON.stringify(result).includes("secret-command-text"));
    assert(!text.includes("secret-command-text"));
  }
  assert.equal(stops, 0);
  assert.equal(starts, 0);
  checks.push("unavailable-elevated-process-identity-reports-safe-fields-and-blocks-mutation");
}

{
  const state = withAdditionalProcesses(healthyState());
  state.listeners = [{ pid: 1003, address: "127.0.0.1" }];
  const result = await restartMcp({ driver: { readState: async () => state, stop: async () => assert.fail("unexpected stop") }, inspectLocks: noLocks });
  assert.equal(result.code, "MCP_LISTENER_OWNERSHIP_INVALID");
  const orphan = orphanState();
  orphan.processes[1].startedAt = "1970-01-01T00:00:00.000Z";
  const reused = await restartMcp({ driver: { readState: async () => orphan, stopOrphans: async () => assert.fail("unexpected cleanup") }, inspectLocks: noLocks });
  assert.equal(reused.code, "MCP_ORPHAN_PROCESS_TREE_INVALID");
  checks.push("additional-processes-do-not-weaken-listener-or-orphan-pid-reuse-guards");
}

{
  let reads = 0, stops = 0, starts = 0;
  const result = await checkMcp({
    driver: { readState: async () => { reads++; return healthyState(); }, stop: async () => { stops++; }, start: async () => { starts++; } },
    inspectLocks: noLocks, sleep: async () => {}, stabilitySamples: 2, pollIntervalMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(reads, 2);
  assert.equal(stops, 0);
  assert.equal(starts, 0);
  checks.push("check-only-is-read-only-and-requires-stable-processes");
}


{
  let queried = false;
  const result = await checkMcp({
    driver: { readState: async () => { queried = true; return healthyState(); } },
    inspectLocks: async () => ({ active: { record: { state: "unknown" } }, maintenance: null }),
    stabilitySamples: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MCP_UNKNOWN_LOCK_PRESENT");
  assert.equal(result.processCheck, "running");
  assert.equal(queried, true);
  checks.push("unknown-lock-blocks-check-before-task-inspection");
}

{
  for (const locks of [
    { active: { record: { state: "running" } }, maintenance: null },
    { active: { record: { state: "unknown" } }, maintenance: null },
    { active: null, maintenance: { record: {} } },
  ]) {
    let reads = 0, stops = 0, starts = 0;
    const result = await restartMcp({
      driver: {
        readState: async () => { reads++; return healthyState(); },
        stop: async () => { stops++; }, start: async () => { starts++; },
      },
      inspectLocks: async () => locks,
    });
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight");
    assert.equal(reads, 0);
    assert.equal(stops, 0);
    assert.equal(starts, 0);
  }
  checks.push("restart-never-stops-or-starts-with-active-unknown-or-maintenance-lock");
}

{
  let phase = "ready", stops = 0, starts = 0, fullReads = 0, monitorReads = 0;
  const driver = {
    readState: async () => { fullReads++; return phase === "ready" ? readyState() : healthyState(300); },
    readMonitorState: async () => { monitorReads++; return healthyState(300); },
    stop: async () => { stops++; phase = "stopped"; },
    start: async () => { starts++; phase = "running"; },
  };
  const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0, stableSamples: 2 });
  assert.equal(result.ok, true);
  assert.equal(stops, 0);
  assert.equal(starts, 1);
  assert.equal(fullReads, 3);
  assert.equal(monitorReads, 1);
  checks.push("ready-with-no-processes-starts-without-stop-and-uses-filtered-postcheck");
}

{
  let phase = "orphan", stops = 0, starts = 0;
  const driver = {
    readState: async () => phase === "orphan" ? orphanState() : phase === "ready" ? readyState() : healthyState(400),
    stopOrphans: async (name, processes) => {
      assert.equal(name, NEW_TASK);
      assert.deepEqual(processes.map(process => process.pid), [202, 201, 200]);
      stops++;
      phase = "ready";
    },
    start: async () => { starts++; phase = "running"; },
  };
  const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0, stableSamples: 2 });
  assert.equal(result.ok, true);
  assert.equal(stops, 1);
  assert.equal(starts, 1);
  checks.push("ready-orphan-pair-is-identity-cleaned-before-start");
}

{
  let phase = "running", stops = 0, starts = 0, passedName;
  const driver = {
    readState: async () => phase === "running" ? healthyState(100, NEW_TASK) : readyState(NEW_TASK),
    stop: async name => { stops++; passedName = name; phase = "ready"; },
    start: async name => { starts++; assert.equal(name, NEW_TASK); phase = "running"; },
  };
  const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0, stableSamples: 2 });
  assert.equal(result.ok, true);
  assert.equal(stops, 1);
  assert.equal(starts, 1);
  assert.equal(passedName, NEW_TASK);
  checks.push("running-task-is-stopped-and-restarted-on-selected-new-name");
}

{
  let phase = "running", stops = 0, orphanStops = 0, starts = 0;
  const driver = {
    readState: async () => phase === "running" ? healthyState(500)
      : phase === "orphan" ? orphanState(501)
        : phase === "ready" ? readyState() : healthyState(600),
    stop: async () => { stops++; phase = "orphan"; },
    stopOrphans: async (_name, processes) => { assert.equal(processes.length, 3); orphanStops++; phase = "ready"; },
    start: async () => { starts++; phase = "started"; },
  };
  const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0, stableSamples: 2 });
  assert.equal(result.ok, true);
  assert.equal(stops, 1);
  assert.equal(orphanStops, 1);
  assert.equal(starts, 1);
  checks.push("running-stop-cleans-only-verified-orphans-left-by-task-stop");
}

{
  let phase = "running", fullReads = 0, monitorReads = 0, orphanStops = 0;
  const driver = {
    readState: async () => {
      fullReads++;
      if (phase === "running") return healthyState(100);
      if (phase === "ready") return readyState();
      return healthyState(300);
    },
    readMonitorState: async expected => {
      monitorReads++;
      assert(expected.length >= 3);
      if (phase === "orphan") return orphanState(101);
      if (phase === "ready") return readyState();
      return healthyState(300);
    },
    stop: async () => { phase = "orphan"; },
    stopOrphans: async (_name, processes) => {
      assert.deepEqual(processes.map(process => process.pid), [103, 102, 101]);
      orphanStops++;
      phase = "ready";
    },
    start: async () => { phase = "started"; },
  };
  const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0, stableSamples: 3 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(orphanStops, 1);
  assert.equal(fullReads, 4, "preflight, stop recheck, before-start, and strict first post-start snapshot remain");
  assert.equal(monitorReads, 4, "one clean stop sample precedes the full before-start recheck");
  checks.push("restart-keeps-strict-boundaries-and-uses-filtered-stop-and-stability-polls");
}

{
  for (const [name, mutate, code] of [
    ["new-process", state => { state.processes = [makeProcess(301, 999, "tunnel")]; }, "MCP_ORPHAN_PROCESS_SET_INVALID"],
    ["listener", state => { state.listeners = [{ pid: 999, address: "127.0.0.1" }]; }, "MCP_LISTENER_OWNERSHIP_INVALID"],
    ["task-name", state => { state.task.name = "Other task"; }, "MCP_TASK_NOT_FOUND_OR_AMBIGUOUS"],
  ]) {
    let stopped = false, starts = 0;
    const result = await restartMcp({
      driver: {
        readState: async () => { const state = stopped ? readyState() : healthyState(); if (stopped) mutate(state); return state; },
        readMonitorState: async () => readyState(),
        stop: async () => { stopped = true; }, start: async () => { starts++; },
      },
      inspectLocks: noLocks,
    });
    assert.equal(result.code, code, name);
    assert.equal(result.phase, "before-start", name);
    assert.equal(starts, 0, name);
  }
  checks.push("full-before-start-recheck-blocks-races-after-a-single-clean-stop-sample");
}

{
  let clock = 0, stage = "running";
  const result = await restartMcp({
    driver: {
      readState: async () => { clock += 800; return stage === "running" ? healthyState() : stage === "ready" ? readyState() : healthyState(300); },
      readMonitorState: async () => { clock += 800; return stage === "ready" ? readyState() : healthyState(400); },
      stop: async () => { stage = "ready"; }, start: async () => { stage = "started"; },
    },
    inspectLocks: noLocks, now: () => clock,
    sleep: async () => assert.fail("slow state queries already cover the polling interval"),
  });
  assert.equal(result.ok, true);
  checks.push("default-restart-still-requires-two-matching-poststart-identities-without-extra-sleep");
}

{
  const cases = [
    ["pid-reused", state => { state.processes[1].commandHash = "b".repeat(64); }, "MCP_ORPHAN_PROCESS_IDENTITY_CHANGED"],
    ["new-candidate", state => { state.processes.push(makeProcess(301, 999, "tunnel")); }, "MCP_ORPHAN_PROCESS_SET_INVALID"],
    ["task-state-race", state => { state.task.state = "Running"; }, "MCP_RUNNING_PROCESS_SET_INVALID"],
    ["listener-owner-changed", state => { state.listeners = [{ pid: 999, address: "127.0.0.1" }]; }, "MCP_LISTENER_OWNERSHIP_INVALID"],
  ];
  for (const [name, mutate, expectedCode] of cases) {
    let phase = "running", cleanups = 0, starts = 0;
    const driver = {
      readState: async () => phase === "running" ? healthyState(100) : readyState(),
      readMonitorState: async () => {
        const state = orphanState(101);
        mutate(state);
        return state;
      },
      stop: async () => { phase = "stopped"; },
      stopOrphans: async () => { cleanups++; },
      start: async () => { starts++; },
    };
    const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0, stopTimeoutMs: 0 });
    if (expectedCode === "MCP_ORPHAN_PROCESS_IDENTITY_CHANGED") assert.equal(result.code, expectedCode, name);
    else {
      assert.equal(result.code, "MCP_TASK_STOP_TIMEOUT", name);
      assert.equal(result.lastCode, expectedCode, name);
    }
    assert.equal(cleanups, 0, name);
    assert.equal(starts, 0, name);
  }
  checks.push("filtered-stop-polls-block-pid-reuse-new-candidates-task-races-and-misowned-listeners");
}

{
  let phase = "running", cleanupPids, starts = 0;
  const driver = {
    readState: async () => phase === "running" ? healthyState(100) : phase === "started" ? healthyState(300) : readyState(),
    readMonitorState: async () => phase === "orphan" ? ({
      ...orphanState(101),
      processes: [...orphanState(101).processes, makeProcess(104, 102, "conhost.exe")],
    }) : phase === "ready" ? readyState() : healthyState(300),
    stop: async () => { phase = "orphan"; },
    stopOrphans: async (_name, processes) => { cleanupPids = processes.map(process => process.pid); phase = "ready"; },
    start: async () => { starts++; phase = "started"; },
  };
  const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0, stableSamples: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(cleanupPids, [103, 102, 101]);
  assert.equal(starts, 1);
  checks.push("filtered-orphan-cleanup-only-receives-verified-owned-processes");
}

{
  let phase = "running", lockReads = 0, cleanups = 0, starts = 0;
  const driver = {
    readState: async () => phase === "running" ? healthyState(100) : readyState(),
    readMonitorState: async () => orphanState(101),
    stop: async () => { phase = "stopped"; },
    stopOrphans: async () => { cleanups++; phase = "ready"; },
    start: async () => { starts++; },
  };
  const inspectLocks = async () => ++lockReads < 3 ? noLocks()
    : ({ active: { record: { state: "unknown" } }, maintenance: null });
  const result = await restartMcp({ driver, inspectLocks, sleep: async () => {}, pollIntervalMs: 0 });
  assert.equal(result.code, "MCP_UNKNOWN_LOCK_PRESENT");
  assert.equal(cleanups, 0);
  assert.equal(starts, 0);
  checks.push("unknown-lock-created-during-filtered-stop-poll-blocks-orphan-cleanup");
}

{
  let stage = "ready", lockReads = 0, starts = 0, monitorReads = 0;
  const driver = {
    readState: async () => stage === "ready" ? readyState() : healthyState(300),
    readMonitorState: async () => { monitorReads++; return healthyState(300); },
    start: async () => { starts++; stage = "started"; },
  };
  const inspectLocks = async () => ++lockReads <= 4 ? noLocks()
    : ({ active: { record: { state: "running" } }, maintenance: null });
  const result = await restartMcp({ driver, inspectLocks, sleep: async () => {}, pollIntervalMs: 0, stableSamples: 3 });
  assert.equal(result.code, "MCP_ACTIVE_LOCK_PRESENT");
  assert.equal(starts, 1);
  assert.equal(monitorReads, 0, "lock is rechecked before each monitored process snapshot");
  checks.push("lock-created-after-start-blocks-postcheck-before-monitoring");
}

{
  let stage = "ready", starts = 0;
  let clock = 0;
  const driver = {
    readState: async () => stage === "ready" ? readyState() : healthyState(300),
    readMonitorState: async () => { clock = 1; return { ...healthyState(300), task: taskInfo("Ready") }; },
    start: async () => { starts++; stage = "started"; },
  };
  const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0,
    stableSamples: 2, startTimeoutMs: 1, now: () => clock });
  assert.equal(result.code, "MCP_RESTART_READINESS_TIMEOUT");
  assert.equal(result.lastCode, "MCP_READY_LAUNCHER_PRESENT");
  assert.equal(starts, 1);
  checks.push("strict-first-poststart-check-is-followed-by-race-sensitive-monitor-state");
}

{
  const wrongOwner = healthyState(700);
  wrongOwner.processes[1] = makeProcess(701, 700, "tunnel", {
    executablePath: "C:\\Other\\tunnel-client.exe", tunnel: false,
  });
  wrongOwner.listeners = [{ pid: 701, address: "127.0.0.1" }];
  let stops = 0, starts = 0;
  const result = await restartMcp({
    driver: { readState: async () => wrongOwner, stop: async () => { stops++; }, start: async () => { starts++; } },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_PROCESS_IDENTITY_MISMATCH");
  assert.equal(stops, 0);
  assert.equal(starts, 0);
  checks.push("wrong-executable-owner-is-never-stopped");
}

{
  const reusedIdentity = healthyState(750);
  reusedIdentity.processes[2].startedAt = "";
  let stops = 0, starts = 0;
  const result = await restartMcp({
    driver: { readState: async () => reusedIdentity, stop: async () => { stops++; }, start: async () => { starts++; } },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_PROCESS_IDENTITY_UNAVAILABLE");
  assert.equal(stops, 0);
  assert.equal(starts, 0);
  checks.push("missing-creation-identity-blocks-restart");
}

{
  const wrongCommand = healthyState(775);
  wrongCommand.processes[2].mcp = false;
  let stops = 0;
  const result = await restartMcp({
    driver: { readState: async () => wrongCommand, stop: async () => { stops++; }, start: async () => {} },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_PROCESS_IDENTITY_MISMATCH");
  assert.equal(stops, 0);
  checks.push("wrong-commandline-candidate-blocks-restart");
}

{
  const invalidAction = healthyState(790);
  invalidAction.task.actionValid = false;
  let stops = 0;
  const result = await restartMcp({
    driver: { readState: async () => invalidAction, stop: async () => { stops++; }, start: async () => {} },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_TASK_ACTION_CHANGED");
  assert.equal(stops, 0);
  checks.push("changed-scheduled-task-action-blocks-restart");
}

{
  const ambiguousParent = orphanState(780);
  ambiguousParent.processes[0].parentExists = true;
  let orphanStops = 0, starts = 0;
  const result = await restartMcp({
    driver: {
      readState: async () => ambiguousParent,
      stopOrphans: async () => { orphanStops++; },
      start: async () => { starts++; },
    },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_ORPHAN_PROCESS_SET_INVALID");
  assert.equal(orphanStops, 0);
  assert.equal(starts, 0);
  checks.push("orphan-with-live-parent-is-not-terminated");
}

{
  const reusedParent = healthyState(785);
  reusedParent.processes[1].startedAt = new Date((reusedParent.processes[0].pid - 1) * 1000).toISOString();
  let stops = 0;
  const result = await restartMcp({
    driver: { readState: async () => reusedParent, stop: async () => { stops++; }, start: async () => {} },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_RUNNING_PROCESS_TREE_INVALID");
  assert.equal(stops, 0);
  checks.push("parent-created-after-child-is-treated-as-pid-reuse");
}

{
  const ambiguous = healthyState(800);
  ambiguous.processes.push(makeProcess(810, 10, "tunnel"));
  let stops = 0, starts = 0;
  const result = await restartMcp({
    driver: { readState: async () => ambiguous, stop: async () => { stops++; }, start: async () => { starts++; } },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_RUNNING_PROCESS_SET_INVALID");
  assert.equal(stops, 0);
  assert.equal(starts, 0);
  checks.push("ambiguous-tunnel-candidates-block-restart");
}

{
  const wrongListener = healthyState(900);
  wrongListener.listeners = [{ pid: 9999, address: "127.0.0.1" }];
  let stops = 0;
  const result = await restartMcp({
    driver: { readState: async () => wrongListener, stop: async () => { stops++; }, start: async () => {} },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_LISTENER_OWNERSHIP_INVALID");
  assert.equal(stops, 0);
  checks.push("unexpected-8080-owner-blocks-task-stop");
}

{
  const ambiguousTasks = healthyState();
  ambiguousTasks.task.count = 2;
  let stops = 0;
  const result = await restartMcp({
    driver: { readState: async () => ambiguousTasks, stop: async () => { stops++; }, start: async () => {} },
    inspectLocks: noLocks,
  });
  assert.equal(result.code, "MCP_TASK_NOT_FOUND_OR_AMBIGUOUS");
  assert.equal(stops, 0);
  checks.push("ambiguous-task-count-fails-closed");
}

{
  for (const badLocks of [{ active: null }, { maintenance: null }]) {
    let stops = 0, starts = 0;
    const result = await restartMcp({
      driver: { readState: async () => readyState(), stop: async () => { stops++; }, start: async () => { starts++; } },
      inspectLocks: async () => badLocks,
    });
    assert.equal(result.ok, false);
    assert.equal(stops, 0);
    assert.equal(starts, 0);
  }
  checks.push("missing-or-unreadable-lock-state-blocks-restart");
}

{
  let lockReads = 0, starts = 0;
  const driver = { readState: async () => readyState(), start: async () => { starts++; } };
  const inspectLocks = async () => ++lockReads < 3 ? { active: null, maintenance: null }
    : { active: null, maintenance: { record: {} } };
  const result = await restartMcp({ driver, inspectLocks, sleep: async () => {}, pollIntervalMs: 0 });
  assert.equal(result.code, "MCP_MAINTENANCE_LOCK_PRESENT");
  assert.equal(result.phase, "before-start");
  assert.equal(starts, 0);
  checks.push("maintenance-lock-rechecked-before-start");
}

{
  for (const operation of ["stop", "start"]) {
    let stops = 0, starts = 0;
    const driver = {
      readState: async () => operation === "stop" ? healthyState() : readyState(),
      stop: async () => { stops++; throw new Error("outcome unavailable"); },
      start: async () => { starts++; throw new Error("outcome unavailable"); },
    };
    const result = await restartMcp({ driver, inspectLocks: noLocks, sleep: async () => {}, pollIntervalMs: 0 });
    assert.equal(result.code, operation === "stop" ? "MCP_TASK_STOP_FAILED" : "MCP_TASK_START_FAILED");
    assert.equal(stops, operation === "stop" ? 1 : 0);
    assert.equal(starts, operation === "start" ? 1 : 0);
  }
  checks.push("uncertain-stop-and-start-results-are-never-retried");
}

{
  let now = 0, starts = 0;
  const result = await restartMcp({
    driver: { readState: async () => readyState(), start: async () => { starts++; } },
    inspectLocks: noLocks, sleep: async () => {}, now: () => now++, startTimeoutMs: 0,
  });
  assert.equal(result.code, "MCP_RESTART_READINESS_TIMEOUT");
  assert.equal(result.phase, "post-check");
  assert.equal(starts, 1);
  checks.push("postcheck-timeout-does-not-claim-success");
}

{
  const text = formatFailure("restart", { code: "MCP_TASK_START_FAILED", phase: "starting" });
  assert(!/token|secret|password|credential/i.test(text));
  assert(text.includes("Do not retry automatically"));
  checks.push("failure-guidance-is-safe-and-does-not-claim-success");
  const failedCheck = { code: "MCP_WINDOWS_QUERY_FAILED", phase: "preflight" };
  assert.match(formatFailure("check", failedCheck, "ja"), /管理者として開いたPowerShellで `thriftyrelay mcp check` を再実行してください/);
  assert.match(formatFailure("check", failedCheck, "en"), /Run `thriftyrelay mcp check` again from an elevated PowerShell/);
}

const testRootInput = process.env.THRIFTYRELAY_TEST_ROOT;
assert(testRootInput && path.isAbsolute(testRootInput), "run this suite through tests/test-runner.mjs");
const testRoot = await fs.realpath(testRootInput);
if (process.platform === "win32") {
  const treeScript = path.join(testRoot, "foreground-tree-fixture.mjs");
  await fs.writeFile(treeScript, [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
    'process.stdout.write(String(child.pid) + "\\n");',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  const owner = spawn(process.execPath, [treeScript], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let line = "";
  const childPidText = new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.stdout.setEncoding("utf8");
    owner.stdout.on("data", chunk => {
      line += chunk;
      const end = line.indexOf("\n");
      if (end >= 0) resolve(line.slice(0, end).trim());
    });
  });
  let cleanupResult;
  try {
    const descendantPid = Number(await childPidText);
    assert(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    let rows = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      rows = await probeProcesses([owner.pid], true);
      if (rows.some(row => row.pid === descendantPid)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const root = rows.find(row => row.pid === owner.pid);
    assert(root?.started_at && root.executable);
    assert(rows.some(row => row.pid === descendantPid), "fixture child must be in the owned process tree");
    cleanupResult = await terminateOwnedProcessTree({
      pid: owner.pid,
      expectedPath: root.executable,
      expectedStartedAt: root.started_at,
      processProbe: probeProcesses,
      attempts: 30,
      intervalMs: 100,
    });
    assert.deepEqual(cleanupResult, { ok: true });
    assert.deepEqual(await probeProcesses([owner.pid], true), []);
    checks.push("foreground-owned-process-tree-cleanup-stops-only-fixture-root-and-descendants");
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const taskkillPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
      spawnSync(taskkillPath, ["/PID", String(owner.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
      owner.kill();
      await new Promise(resolve => owner.once("close", resolve));
    }
    await fs.rm(treeScript, { force: true });
  }
}
{
  const localeCheck = validateLocaleCatalogs();
  assert(localeCheck.keys > 100);
  assert.throws(() => validateLocaleCatalogs({ message: "Value {first}" }, { message: "値 {second}" }), /PLACEHOLDER_PARITY/);
  assert.equal(languageFromLocale("ja_JP.UTF-8"), "ja");
  assert.equal(languageFromLocale("en-US"), "en");
  assert.equal(languageFromLocale("fr-FR"), null);
  assert.equal(languageFromLocale("unknown"), null);
  assert.equal(getConfigPath({ env: { APPDATA: "C:\\Users\\fixture\\Roaming" }, platform: "win32", home: "C:\\Users\\fixture" }), path.win32.join("C:\\Users\\fixture\\Roaming", "ThriftyRelay", "config.json"));

  const configFile = path.join(testRoot, "i18n", "config.json");
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify({ language: "en", provider: { mode: "preserved" }, auth: { marker: "never-print" } }));
  assert.deepEqual(await resolveLanguagePreference({ configFile, osLocale: "ja-JP" }), { language: "en", source: "saved" });
  assert.deepEqual(await resolveLanguagePreference({ explicitLanguage: "ja", configFile: path.dirname(configFile), osLocale: "en-US" }), { language: "ja", source: "explicit" });
  assert.deepEqual(await resolveLanguagePreference({ configFile, osLocale: "fr-FR" }), { language: "en", source: "saved" });
  assert.deepEqual(await resolveLanguagePreference({ configFile: path.join(testRoot, "absent", "config.json"), osLocale: "ja-JP" }), { language: "ja", source: "os" });
  assert.deepEqual(await resolveLanguagePreference({ configFile: path.join(testRoot, "absent", "config.json"), osLocale: "fr-FR" }), { language: "en", source: "fallback" });
  assert.equal(await getSavedLanguage(configFile), "en");
  await saveLanguage("ja", configFile);
  const preserved = JSON.parse(await fs.readFile(configFile, "utf8"));
  assert.equal(preserved.language, "ja");
  assert.deepEqual(preserved.provider, { mode: "preserved" });
  assert.deepEqual(preserved.auth, { marker: "never-print" });

  const env = { ...process.env, THRIFTYRELAY_CONFIG_PATH: configFile };
  // Run through the public CLI so the lang subcommand's hand-off to its script is covered too.
  const cliEntry = path.resolve(import.meta.dirname, "..", "scripts", "cli.mjs");
  const runLang = args => spawnSync(process.execPath, [cliEntry, "lang", ...args], {
    encoding: "utf8", env, windowsHide: true,
  });
  const cli = runLang(["en"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Language saved: English \(en\)\./);
  assert(!cli.stdout.includes("never-print"));
  const viewCli = runLang([]);
  assert.equal(viewCli.status, 0, viewCli.stderr);
  assert.match(viewCli.stdout, /Current language: English \(en\)\./);
  assert.match(viewCli.stdout, /Selection source: saved setting\./);
  const invalidCli = runLang(["de"]);
  assert.equal(invalidCli.status, 1);
  assert.match(invalidCli.stderr, /LANG_UNSUPPORTED/);
  assert(!invalidCli.stderr.includes("never-print"));
  assert.equal((await getSavedLanguage(configFile)), "en");

  assert.deepEqual(parseLanguageFlags(["--task-dir", "C:\\task", "--lang", "ja"]), { args: ["--task-dir", "C:\\task"], explicitLanguage: "ja" });
  assert.deepEqual(parseLanguageFlags(["check", "--lang=en"]), { args: ["check"], explicitLanguage: "en" });
  assert.throws(() => parseLanguageFlags(["--lang", "fr"]), { code: "LANG_UNSUPPORTED", languageValue: "fr" });
  assert.throws(() => parseLanguageFlags(["--lang"]), { code: "LANG_ARGUMENTS_INVALID" });
  assert.throws(() => validateLanguage("fr"), { code: "LANG_UNSUPPORTED" });
  const unsupportedMessage = formatLanguageError({ code: "LANG_UNSUPPORTED", languageValue: "never-print" }, "ja");
  assert.match(unsupportedMessage, /LANG_UNSUPPORTED.*未対応/);
  assert(!unsupportedMessage.includes("never-print"));
  assert.match(translate("fr", "cli.language.unsupported", { language: "fr" }), /Unsupported language/);
  assert.match(translate("ja", "cli.language.saved"), /\{name\}.*\{language\}/);
  assert.match(formatFailure("restart", { code: "MCP_TASK_START_FAILED", phase: "starting" }, "ja"), /MCP_TASK_START_FAILED/);
  assert.match(recoveryFailure("REMOTE_HUMAN_APPROVAL_REQUIRED", "ja"), /REMOTE_HUMAN_APPROVAL_REQUIRED.*yes/);

  const english = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../locales/en.json"), "utf8"));
  const japanese = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../locales/ja.json"), "utf8"));
  const serverSource = await fs.readFile(path.resolve(import.meta.dirname, "../src/server.mjs"), "utf8");
  for (const toolName of ["health", "remote_task", "remote_inspect"]) {
    // Protocol identifiers must stay literals instead of going through translate().
    assert(serverSource.includes(`registerTool("${toolName}"`));
    assert.equal(Object.hasOwn(english, `mcp.tool.${toolName}`), false);
    assert.equal(Object.hasOwn(japanese, `mcp.tool.${toolName}`), false);
  }
  for (const toolName of ["remote_task", "remote_inspect"]) {
    assert(Object.values(english).every(value => !value.includes(toolName)));
    assert(Object.values(japanese).every(value => !value.includes(toolName)));
  }
  await fs.rm(path.dirname(configFile), { recursive: true, force: true });
  checks.push("localization-priority-config-merge-fallback-parity-cli-validation-and-protocol-identifiers");
}

const fixtureDir = await fs.mkdtemp(path.join(testRoot, "guided-recovery-"));
const taskId = "task_abcde_123456";
const lockHash = "a".repeat(64);
const phrase = `UNLOCK ${taskId} ${lockHash.slice(0, 12)}`;

const EOF = Symbol("EOF");

function simulatedReadline(answer, { signal = false } = {}) {
  let questions = 0, sigint, wasTerminal = false;
  return {
    get questions() { return questions; },
    get wasTerminal() { return wasTerminal; },
    createReadline: ({ output, terminal }) => {
      wasTerminal = terminal;
      return {
        on(event, handler) { if (event === "SIGINT") sigint = handler; return this; },
        async question(prompt) {
          questions++;
          output.write(prompt);
          if (signal) { sigint?.(); throw new Error("simulated Ctrl+C"); }
          if (answer === EOF) throw new Error("simulated EOF");
          return answer;
        },
        close() {},
      };
    },
  };
}

function recoveryStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let outputText = "";
  output.setEncoding("utf8");
  output.on("data", chunk => { outputText += chunk; });
  return { input, output, outputText: () => outputText };
}

function recoveryFixture({ currentProcesses } = {}) {
  let active = { record: { task_id: taskId, kind: "codex", state: "unknown",
    owner: { pid: 50, started_at: "2026-10-17T00:00:00.000Z" },
    processes: [{ pid: 60, parent_pid: 50, started_at: "2026-10-17T00:00:01.000Z" }] }, sha256: lockHash };
  let calls = 0;
  const inspect = async () => {
    calls++;
    return {
      active, maintenance: null,
      task: { id: taskId, status: "failed", finished_at: "2026-10-17T00:00:00.000Z" },
      current_processes: currentProcesses || [
        { pid: 50, parent_pid: 1, started_at: "2026-10-17T00:00:00.000Z", executable: "C:\\Program Files\\nodejs\\node.exe" },
        { pid: 55, parent_pid: 50, started_at: "2026-10-17T00:00:02.000Z", executable: "C:\\Windows\\conhost.exe" },
      ],
    };
  };
  return { inspect, get active() { return active; }, set active(value) { active = value; }, get calls() { return calls; } };
}

{
  const fixture = recoveryFixture();
  const streams = recoveryStreams();
  const terminal = simulatedReadline("YeS");
  let approved, confirmed = false;
  const result = await runGuidedRecovery({
    input: streams.input, output: streams.output, isInteractive: true,
    args: ["--task-dir", fixtureDir], inspect: fixture.inspect,
    showGitStatus: output => {
      output.write("\nMachine-observed Git summary: 4 changed paths; two tracked and two untracked.");
      return { available: true, statusSummary: "4 changed paths (2 tracked, 2 untracked)", diffSummary: "unstaged: 3 files changed; staged: none" };
    },
    username: () => "test-user", createReadline: terminal.createReadline,
    recover: async request => {
      approved = request.approval;
      for (const key of ["process_evidence", "file_evidence", "external_evidence"]) {
        assert(approved[key].length > 10 && approved[key].length <= 2000);
        assert(approved[key].includes("Machine observed:"));
        assert(approved[key].includes("Operator attested"));
      }
      assert(approved.process_evidence.includes("worker PIDs=60"));
      assert(approved.file_evidence.includes("4 changed paths"));
      assert(approved.external_evidence.includes("effects are unknown"));
      confirmed = await request.confirm({ task_id: taskId, lock_sha256: lockHash });
      assert.equal(confirmed, true);
      fixture.active = null;
      return { decision: "released", audit_id: "fixture-audit" };
    },
  });
  assert.equal(result.recovered, true);
  assert.equal(fixture.calls, 2);
  assert.equal(terminal.questions, 1);
  assert.equal(terminal.wasTerminal, true);
  assert.equal(confirmed, true);
  assert.equal(approved.owned_processes_stopped, true);
  assert.equal(approved.files_reviewed, true);
  assert.equal(approved.external_operations_reviewed, true);
  assert(streams.outputText().includes("Lock release verified."));
  assert(streams.outputText().includes("Stored owner PID: 50"));
  assert(streams.outputText().includes("PID 55 | parent 50"));
  assert(streams.outputText().includes("untracked and ignored files"));
  assert(streams.outputText().includes("External effects"));
  assert(streams.outputText().includes("[y/N]"));
  assert(streams.outputText().includes("outcome remains unknown"));
  checks.push("guided-recovery-shows-observations-and-records-machine-facts-plus-three-operator-attestations-with-one-yes");
}

{
  for (const [label, answer, signal, expectedCode] of [
    ["no", "NO", false, "REMOTE_HUMAN_APPROVAL_REQUIRED"],
    ["blank", "", false, "REMOTE_HUMAN_APPROVAL_REQUIRED"],
    ["invalid", "unlock", false, "REMOTE_HUMAN_APPROVAL_REQUIRED"],
    ["eof", EOF, false, "REMOTE_GUIDED_INPUT_CANCELLED"],
    ["ctrl-c", null, true, "REMOTE_GUIDED_INPUT_CANCELLED"],
  ]) {
    const fixture = recoveryFixture();
    const streams = recoveryStreams();
    const terminal = simulatedReadline(answer, { signal });
    let recoverCalls = 0;
    await assert.rejects(runGuidedRecovery({
      input: streams.input, output: streams.output, isInteractive: true,
      args: ["--task-dir", fixtureDir], inspect: fixture.inspect, showGitStatus: () => ({ statusSummary: "fixture", diffSummary: "fixture" }),
      createReadline: terminal.createReadline,
      recover: async request => {
        recoverCalls++;
        const approved = await request.confirm({ task_id: taskId, lock_sha256: lockHash });
        assert.equal(approved, false, label);
        throw Object.assign(new Error(), { code: "REMOTE_HUMAN_APPROVAL_REQUIRED" });
      },
    }), { code: expectedCode });
    assert.equal(terminal.questions, 1, label);
    assert.equal(recoverCalls, 1, label);
    assert.notEqual(fixture.active, null, label);
  }
  checks.push("guided-recovery-no-blank-invalid-eof-and-ctrl-c-never-release-lock");
}

{
  const fixture = recoveryFixture({ currentProcesses: [
    { pid: 50, parent_pid: 1, started_at: "2026-10-17T00:00:00.000Z", executable: "C:\\Program Files\\nodejs\\node.exe" },
    { pid: 60, parent_pid: 50, started_at: "2026-10-17T00:00:01.000Z", executable: "C:\\Program Files\\nodejs\\node.exe" },
  ] });
  const streams = recoveryStreams();
  const terminal = simulatedReadline("y");
  let recoverCalls = 0;
  await assert.rejects(runGuidedRecovery({
    input: streams.input, output: streams.output, isInteractive: true,
    args: ["--task-dir", fixtureDir], inspect: fixture.inspect,
    createReadline: terminal.createReadline,
    recover: async () => { recoverCalls++; },
  }), { code: "REMOTE_OWNED_PROCESS_STILL_ALIVE" });
  assert.equal(terminal.questions, 0);
  assert.equal(recoverCalls, 0);
  assert.notEqual(fixture.active, null);
  checks.push("guided-recovery-blocks-while-recorded-worker-remains-active");
}

{
  const fixture = recoveryFixture();
  const streams = recoveryStreams();
  const terminal = simulatedReadline("yes");
  await assert.rejects(runGuidedRecovery({
    input: streams.input, output: streams.output, isInteractive: true,
    args: ["--task-dir", fixtureDir], inspect: fixture.inspect,
    createReadline: terminal.createReadline,
    recover: async request => {
      assert.equal(request.approval.lock_sha256, lockHash);
      fixture.active = { ...fixture.active, sha256: "b".repeat(64) };
      throw Object.assign(new Error(), { code: "REMOTE_LOCK_CHANGED" });
    },
  }), { code: "REMOTE_LOCK_CHANGED" });
  assert.equal(terminal.questions, 0);
  assert.notEqual(fixture.active, null);
  checks.push("guided-recovery-changed-lock-fails-closed-before-yes-no-prompt");
}

{
  let inspected = false, readlineCreated = false;
  const streams = recoveryStreams();
  await assert.rejects(runGuidedRecovery({
    input: streams.input, output: streams.output, isInteractive: false,
    args: ["--task-dir", fixtureDir], inspect: async () => { inspected = true; },
    createReadline: () => { readlineCreated = true; },
  }), { code: "REMOTE_LOCAL_INTERACTIVE_CONSOLE_REQUIRED" });
  assert.equal(inspected, false);
  assert.equal(readlineCreated, false);
  checks.push("guided-recovery-refuses-noninteractive-before-reading-task-data");
}

{
  const streams = recoveryStreams();
  const git = previewGit(streams.output);
  assert.equal(git.available, true);
  assert.match(git.statusSummary, /^\d+ changed paths \(/);
  assert(git.diffSummary.includes("unstaged:") && git.diffSummary.includes("staged:"));
  checks.push("guided-recovery-git-preview-reports-status-and-bounded-diff-summary");
}

{
  const fixture = recoveryFixture();
  const streams = recoveryStreams();
  const terminal = simulatedReadline("n");
  await assert.rejects(runGuidedRecovery({
    input: streams.input, output: streams.output, isInteractive: true,
    args: ["--task-dir", fixtureDir], language: "ja", inspect: fixture.inspect,
    showGitStatus: output => {
      output.write("\nMachine-observed Git summary: 4 changed paths.");
      return { available: true, statusSummary: "4 changed paths", diffSummary: "unstaged: 1 file; staged: none" };
    },
    createReadline: terminal.createReadline,
    recover: async request => {
      assert(request.approval.process_evidence.includes("Machine observed:"));
      assert(request.approval.file_evidence.includes("Machine observed:"));
      assert(request.approval.external_evidence.includes("Machine observed:"));
      assert.equal(await request.confirm({ task_id: taskId, lock_sha256: lockHash }), false);
      throw Object.assign(new Error(), { code: "REMOTE_HUMAN_APPROVAL_REQUIRED" });
    },
  }), { code: "REMOTE_HUMAN_APPROVAL_REQUIRED" });
  const screen = streams.outputText();
  assert(screen.includes("ローカル復旧ガイド"));
  assert(screen.includes("手動確認項目"));
  assert(screen.includes("status=failed; finished_at="));
  assert(screen.includes("[y/N]"));
  assert.equal(terminal.questions, 1);
  assert.notEqual(fixture.active, null);
  assert.match(recoveryFailure("REMOTE_HUMAN_APPROVAL_REQUIRED", "ja"), /REMOTE_HUMAN_APPROVAL_REQUIRED.*yes/);
  checks.push("guided-recovery-japanese-screen-preserves-machine-evidence-and-no-answer-safety");
}

const relative = path.relative(testRoot, fixtureDir);
assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "fixture must remain under isolated test root");
await fs.rm(fixtureDir, { recursive: true, force: true });
const transportChecks = await import("./test-powershell-session.mjs");
checks.push(...transportChecks.checks);
console.log("LOCAL OPS OK " + JSON.stringify({ checks }));
