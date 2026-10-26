import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { TUNNEL_ID } from "../config.mjs";
import { normalizeExecutablePath, probeProcessGroup, terminateProcessGroup } from "../platform/index.mjs";
import { probeProcesses } from "../mcp/execution-guard.mjs";
import { bindProbe, probeListenerOwners } from "./listener.mjs";
import { LOG_FILE_NAME } from "./log.mjs";
import {
  STATE_FILE_NAME, ensureRuntimeDirectory, readRuntimeState, runtimeDirectory, writeRuntimeState,
} from "./state.mjs";
import { acquireRuntimeLock } from "./lock.mjs";
import { createRuntimeRecord, DEFAULT_HEALTH_PORT } from "./record.mjs";

const DEFAULT_PORT = DEFAULT_HEALTH_PORT;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 35_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// detail names which check could not confirm a stop; the code stays the public contract.
function backgroundError(code, cause, detail) {
  return Object.assign(new Error(code), { code, cause }, detail ? { detail } : {});
}

function emptyState({ instanceId, mode, logFile }) {
  return createRuntimeRecord({ instanceId, mode, logFile, port: DEFAULT_PORT });
}

function stateFileFor(directory) {
  return path.posix.join(directory, STATE_FILE_NAME);
}

function isPosixAbsolute(value) {
  return typeof value === "string" && path.posix.isAbsolute(value);
}

async function readOrNull(file) {
  return readRuntimeState(file).catch(error => {
    if (error?.code === "RUNTIME_STATE_UNAVAILABLE") throw error;
    throw error;
  });
}

async function probeSupervisor(state, processProbe) {
  if (!Number.isSafeInteger(state?.supervisorPid) || state.supervisorPid < 1) return "unknown";
  if (!state.supervisorStartedAt) return "unknown";
  let rows;
  try { rows = await processProbe([state.supervisorPid]); }
  catch { return "unknown"; }
  const row = rows.find(item => item.pid === state.supervisorPid);
  if (!row) return "absent";
  if (state.supervisorStartedAt && row.started_at !== state.supervisorStartedAt) return "mismatch";
  const euid = process.geteuid?.();
  if (Number.isSafeInteger(euid) && Number.isSafeInteger(row.uid) && row.uid !== euid) return "mismatch";
  return "alive";
}

async function groupState(state, { probeGroup }) {
  // A record written before the supervisor adopts it has no tunnel pid yet. That
  // is absence evidence only when the supervisor is also absent and the port is free.
  if (!Number.isSafeInteger(state?.tunnelPgid) || state.tunnelPgid < 1) return "absent";
  try {
    const rows = await probeGroup(state.tunnelPgid);
    return rows.length === 0 ? "absent" : "present";
  } catch {
    return "unknown";
  }
}

async function listenerState(port, { bindPort }) {
  try { await bindPort(port); return "free"; }
  catch (error) {
    return error?.code === "LOCAL_ENDPOINT_IN_USE" ? "in-use" : "unknown";
  }
}

function assertLocalRecord(state, stateFile, expectedTunnelExecutable = null, platform = process.platform) {
  const directory = path.posix.dirname(stateFile);
  const expectedLog = path.posix.join(directory, LOG_FILE_NAME);
  if (state.port !== DEFAULT_PORT ||
      state.healthUrl !== `http://127.0.0.1:${DEFAULT_PORT}` ||
      state.logFile !== expectedLog) {
    throw backgroundError("RUNTIME_STATE_STALE");
  }
  if (expectedTunnelExecutable && state.tunnelExecutable &&
      normalizeExecutablePath(state.tunnelExecutable, platform) !==
      normalizeExecutablePath(expectedTunnelExecutable, platform)) {
    throw backgroundError("RUNTIME_STATE_STALE");
  }
}

async function removeState(file) {
  await fs.unlink(file).catch(error => {
    if (error?.code !== "ENOENT") throw backgroundError("RUNTIME_STATE_UNAVAILABLE", error);
  });
}

export async function resolveStartConflict(state, options) {
  if (!state) return "start";
  assertLocalRecord(state, options.stateFile, options.expectedTunnelExecutable, options.platform);
  const supervisor = await probeSupervisor(state, options.processProbe);
  const group = await groupState(state, options);
  const listener = await listenerState(state.port, options);
  if (state.state === "running" && supervisor === "alive") throw backgroundError("RUNTIME_ALREADY_RUNNING");
  if (state.state === "starting" && supervisor === "alive") throw backgroundError("RUNTIME_START_IN_PROGRESS");
  if (state.state === "stopping" && supervisor === "alive") throw backgroundError("RUNTIME_START_IN_PROGRESS");
  if (state.state === "failed" && supervisor === "alive") throw backgroundError("RUNTIME_START_IN_PROGRESS");
  if (supervisor === "mismatch") throw backgroundError("RUNTIME_STATE_STALE");
  if (group === "present") throw backgroundError("RUNTIME_STATE_STALE");
  if (group === "unknown" || listener === "unknown") throw backgroundError("RUNTIME_STATE_STALE");
  if (listener === "in-use") throw backgroundError("LOCAL_ENDPOINT_IN_USE");
  // No supervisor, no group, and the port is free: the terminal record is safe to
  // reclaim. A `starting` record without a supervisor is also reclaimable only
  // after those two independent checks.
  await removeState(options.stateFile);
  return "start";
}

export async function startBackgroundRuntime({
  config,
  configFile,
  packageRoot,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  stateFile = null,
  directory = null,
  processProbe = probeProcesses,
  bindPort = bindProbe,
  ownerProbe = port => probeListenerOwners(port, { platform }),
  probeGroup = pgid => probeProcessGroup(pgid, undefined, platform),
  spawnSupervisor = spawn,
  daemonPath = null,
  startupTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  pollIntervalMs = 250,
  now = Date.now,
  sleepImpl = sleep,
} = {}) {
  if (platform === "win32") throw backgroundError("REMOTE_PLATFORM_UNSUPPORTED");
  if (process.geteuid?.() === 0) throw backgroundError("RUNTIME_AS_ROOT");
  if (!config || !TUNNEL_ID.test(config.tunnelId || "") || !isPosixAbsolute(config.tunnelClientPath || "") ||
      !isPosixAbsolute(config.workspace || "") || !isPosixAbsolute(config.taskDirectory || "")) {
    throw backgroundError("RUNTIME_CONFIG_INVALID");
  }
  let expectedTunnelExecutable;
  try {
    expectedTunnelExecutable = await fs.realpath(config.tunnelClientPath);
    await fs.access(expectedTunnelExecutable, fs.constants.X_OK);
  } catch {
    throw backgroundError("RUNTIME_CONFIG_INVALID");
  }
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) throw backgroundError("RUNTIME_CONFIG_INVALID");
  const runtimeDir = directory || runtimeDirectory({ platform, env, home });
  await ensureRuntimeDirectory(runtimeDir);
  const file = stateFile || stateFileFor(runtimeDir);
  const logFile = path.posix.join(runtimeDir, LOG_FILE_NAME);
  const lock = await acquireRuntimeLock(runtimeDir);
  let instanceId;
  try {
    const existing = await readOrNull(file);
    if (existing) await resolveStartConflict(existing, {
      stateFile: file, processProbe, bindPort, probeGroup, expectedTunnelExecutable, platform,
    });
    await bindPort(DEFAULT_PORT);
    // A start cannot succeed without naming the listener owner later. Probe the tool
    // once before writing state so a missing ss/lsof fails as a dependency error, not
    // as an unexplained owner-verification failure after spawning.
    try { await ownerProbe(DEFAULT_PORT); }
    catch (error) { throw backgroundError(error?.code || "RUNTIME_OWNER_UNKNOWN"); }
    const root = packageRoot || config.packageRoot;
    if (!isPosixAbsolute(root || "")) throw backgroundError("RUNTIME_CONFIG_INVALID");
    const daemon = daemonPath || path.posix.join(root, "scripts", "runtime-daemon.mjs");
    instanceId = randomUUID();
    await writeRuntimeState(file, emptyState({ instanceId, mode: "background", logFile }));
    let child;
    try {
      child = spawnSupervisor(process.execPath, [
        daemon, "--instance-id", instanceId, "--state-file", file, "--config-file", configFile,
      ], {
        cwd: root,
        env,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref?.();
    } catch (error) {
      await removeState(file).catch(() => {});
      throw backgroundError("RUNTIME_TUNNEL_START_FAILED", error);
    }
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) {
      await removeState(file).catch(() => {});
      throw backgroundError("RUNTIME_TUNNEL_START_FAILED");
    }
    // The supervisor owns the state from here. The start lock only protects the
    // decide-and-spawn section, not the up-to-60-second readiness wait.
    await lock.release();
    return await waitForStarted({ file, instanceId, processProbe, startupTimeoutMs, pollIntervalMs, now, sleepImpl });
  } finally {
    await lock.release().catch(() => {});
  }
}

async function waitForStarted({ file, instanceId, processProbe, startupTimeoutMs, pollIntervalMs, now, sleepImpl }) {
  const deadline = now() + startupTimeoutMs;
  while (now() < deadline) {
    const state = await readRuntimeState(file).catch(() => null);
    if (!state || state.instanceId !== instanceId) throw backgroundError("RUNTIME_START_FAILED");
    if (state.state === "failed") throw backgroundError(state.errorCode || "RUNTIME_START_FAILED");
    if (state.state === "stopped") throw backgroundError(state.errorCode || "RUNTIME_START_FAILED");
    if (state.state === "running") return state;
    if (Number.isSafeInteger(state.supervisorPid)) {
      let rows;
      try { rows = await processProbe([state.supervisorPid]); }
      catch { throw backgroundError("RUNTIME_OWNER_UNKNOWN"); }
      if (!rows.some(row => row.pid === state.supervisorPid)) throw backgroundError("RUNTIME_START_FAILED");
    }
    await sleepImpl(pollIntervalMs);
  }
  throw backgroundError("RUNTIME_READINESS_TIMEOUT");
}

async function signalSupervisor(state, { kill = process.kill } = {}) {
  try { kill(state.supervisorPid, "SIGTERM"); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    throw backgroundError("RUNTIME_OWNER_UNKNOWN", error);
  }
}

async function waitForSupervisorExit({ file, instanceId, processProbe, timeoutMs, pollIntervalMs = 250, sleepImpl = sleep }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readRuntimeState(file).catch(() => null);
    if (!state) return { state: null };
    if (state.instanceId !== instanceId) return { state };
    // The terminal record is written before the supervisor closes its log and exits.
    const supervisor = await probeSupervisor(state, processProbe);
    if (supervisor === "absent" || supervisor === "mismatch") return { state };
    await sleepImpl(pollIntervalMs);
  }
  return { state: await readRuntimeState(file).catch(() => null), timeout: true };
}

export async function stopBackgroundRuntime({
  stateFile,
  platform = process.platform,
  processProbe = probeProcesses,
  bindPort = bindProbe,
  probeGroup = pgid => probeProcessGroup(pgid, undefined, platform),
  kill = process.kill,
  timeoutMs = STOP_TIMEOUT_MS,
  pollIntervalMs = 250,
  sleepImpl = sleep,
} = {}) {
  if (platform === "win32") throw backgroundError("REMOTE_PLATFORM_UNSUPPORTED");
  if (!isPosixAbsolute(stateFile || "")) throw backgroundError("RUNTIME_STATE_UNAVAILABLE");
  const directory = path.posix.dirname(stateFile);
  await ensureRuntimeDirectory(directory);
  const lock = await acquireRuntimeLock(directory);
  try {
    const state = await readRuntimeState(stateFile).catch(error => {
      if (error?.code === "RUNTIME_STATE_UNAVAILABLE") throw error;
      throw error;
    });
    if (!state) {
      const listener = await listenerState(DEFAULT_PORT, { bindPort });
      if (listener === "free") return { ok: true, stopped: false };
      if (listener === "in-use") throw backgroundError("RUNTIME_OWNER_UNKNOWN");
      throw backgroundError("RUNTIME_OWNER_UNKNOWN");
    }
    assertLocalRecord(state, stateFile, null, platform);
    const supervisor = await probeSupervisor(state, processProbe);
    if (supervisor === "alive") {
      await signalSupervisor(state, { kill });
    } else if (supervisor === "mismatch") {
      throw backgroundError("RUNTIME_OWNER_MISMATCH");
    }
    // The state file is written only by the supervisor, not by this lock. Release
    // it now so a later start is not blocked by the 35-second stop budget. The
    // instanceId check below prevents this stop from deleting a replacement.
    await lock.release();
    const waited = await waitForSupervisorExit({
      file: stateFile, instanceId: state.instanceId, processProbe, timeoutMs, pollIntervalMs, sleepImpl,
    });
    const latest = waited.state || state;
    if (latest.instanceId !== state.instanceId) {
      return { ok: true, stopped: true, record: latest ? "replaced" : "removed" };
    }
    // A new foreground or background runtime may have started while this stop was
    // waiting. Never inspect or signal the replacement's listener as if it were ours.
    const current = await readRuntimeState(stateFile).catch(() => null);
    if (current && current.instanceId !== state.instanceId) {
      return { ok: true, stopped: true, record: "replaced" };
    }
    // The supervisor is the only component allowed to terminate its tunnel group.
    // If it is still alive after the stop budget, do not bypass it with a direct kill.
    const remainingSupervisor = await probeSupervisor(latest, processProbe);
    if (remainingSupervisor === "mismatch") throw backgroundError("RUNTIME_OWNER_MISMATCH");
    if (remainingSupervisor !== "absent") throw backgroundError("RUNTIME_STOP_UNCONFIRMED", undefined, `supervisor ${remainingSupervisor}`);
    const group = await groupState(latest, { probeGroup });
    const listener = await listenerState(latest.port, { bindPort });
    if (group === "unknown" || listener === "unknown") {
      throw backgroundError("RUNTIME_STOP_UNCONFIRMED", undefined, `group ${group}, listener ${listener}`);
    }
    if (group === "present" || listener === "in-use") {
      const stopped = await terminateRecordedGroup(latest, { probeGroup, kill, sleepImpl });
      if (!stopped) throw backgroundError("RUNTIME_STOP_UNCONFIRMED", undefined, "group termination");
      const afterGroup = await groupState(latest, { probeGroup });
      const afterListener = await listenerState(latest.port, { bindPort });
      if (afterGroup !== "absent" || afterListener !== "free") {
        throw backgroundError("RUNTIME_STOP_UNCONFIRMED", undefined, `after termination: group ${afterGroup}, listener ${afterListener}`);
      }
    }
    let removalLock;
    try { removalLock = await acquireRuntimeLock(directory); }
    catch (error) {
      if (error?.code === "RUNTIME_BUSY") return { ok: true, stopped: true, record: "replaced" };
      throw error;
    }
    try {
      const current = await readRuntimeState(stateFile).catch(() => null);
      if (current && current.instanceId !== state.instanceId) {
        return { ok: true, stopped: true, record: "replaced" };
      }
      await removeState(stateFile);
      return { ok: true, stopped: true };
    } finally {
      await removalLock.release().catch(() => {});
    }
  } finally {
    await lock.release().catch(() => {});
  }
}

async function terminateRecordedGroup(state, { probeGroup, kill, sleepImpl }) {
  if (!Number.isSafeInteger(state.tunnelPgid) || state.tunnelPgid < 1) return false;
  const result = await terminateProcessGroup(state.tunnelPgid, {
    expectedStartedAt: state.tunnelStartedAt,
    expectedExecutable: state.tunnelExecutable,
    kill,
    probe: target => probeGroup(target),
    sleep: sleepImpl,
  }).catch(() => ({ ok: false }));
  return result.ok === true;
}

export async function backgroundStatus({ stateFile, platform = process.platform, processProbe = probeProcesses, bindPort = bindProbe, probeGroup = pgid => probeProcessGroup(pgid, undefined, platform) } = {}) {
  const state = await readRuntimeState(stateFile).catch(error => {
    if (error?.code === "RUNTIME_STATE_UNAVAILABLE") throw error;
    throw error;
  });
  if (!state) return { state: "idle", listener: await listenerState(DEFAULT_PORT, { bindPort }) };
  assertLocalRecord(state, stateFile, null, platform);
  return {
    state: state.state,
    ownerVerified: state.ownerVerified,
    supervisor: await probeSupervisor(state, processProbe),
    group: await groupState(state, { probeGroup }),
    listener: await listenerState(state.port, { bindPort }),
    record: state,
  };
}
