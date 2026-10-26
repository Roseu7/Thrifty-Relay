import path from "node:path";
import { readSetupConfig, TUNNEL_ID } from "../config.mjs";
import { createCredentialStore, normalizeExecutablePath, probeProcessCommand, probeProcessGroup } from "../platform/index.mjs";
import { probeProcesses } from "../mcp/execution-guard.mjs";
import { assertTrustedDirectory, readRuntimeState } from "./state.mjs";
import { LOG_FILE_NAME, createRuntimeLog } from "./log.mjs";
import { updateRuntimeRecord } from "./record.mjs";
import { startForegroundRuntime } from "./foreground.mjs";

const DEFAULT_HEALTH_PORT = 8080;
const TERMINAL_STATES = new Set(["stopped", "failed"]);

function supervisorError(code) {
  return Object.assign(new Error(code), { code });
}

function logLine(output, text) {
  try { output?.write?.(`${new Date().toISOString()} ${text}\n`); } catch {}
}

async function ownIdentity(platform) {
  const rows = await probeProcesses([process.pid]);
  const row = rows.find(item => item.pid === process.pid);
  if (!row) throw supervisorError("RUNTIME_OWNER_UNKNOWN");
  let command = null;
  try { command = await probeProcessCommand(process.pid); } catch {}
  return {
    pid: process.pid,
    uid: process.geteuid?.(),
    startedAt: row.started_at,
    executable: normalizeExecutablePath(row.executable || process.execPath, platform),
    command: command?.command || process.argv.join(" "),
  };
}

async function groupLeader(pid) {
  const rows = await probeProcessGroup(pid);
  const leader = rows.find(row => row.pid === pid);
  if (!leader) throw supervisorError("RUNTIME_OWNER_UNKNOWN");
  return leader;
}

// The supervisor is the only state writer after the parent writes `starting`.
// Every update re-reads the file and checks instanceId + transition before writing.
export async function runBackgroundSupervisor({
  instanceId,
  stateFile,
  configFile,
  env = process.env,
  platform = process.platform,
  startupTimeoutMs = 30_000,
} = {}) {
  if (typeof instanceId !== "string" || typeof stateFile !== "string" || !path.posix.isAbsolute(stateFile)) {
    return 2;
  }
  let state;
  try { state = await readRuntimeState(stateFile); }
  catch { return 1; }
  if (state.instanceId !== instanceId || state.state !== "starting") return 2;
  const expectedLog = path.posix.join(path.posix.dirname(stateFile), LOG_FILE_NAME);
  if (state.mode !== "background" || state.port !== DEFAULT_HEALTH_PORT ||
      state.healthUrl !== `http://127.0.0.1:${DEFAULT_HEALTH_PORT}` || state.logFile !== expectedLog) {
    await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
      state: "failed", errorCode: "RUNTIME_STATE_CONFLICT", cleanup: "unconfirmed",
    }).catch(() => {});
    return 2;
  }

  let output = null;
  let log = null;
  const identity = await ownIdentity(platform).catch(() => null);
  if (!identity) {
    await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
      state: "failed", errorCode: "RUNTIME_OWNER_UNKNOWN", cleanup: "unconfirmed",
    }).catch(() => {});
    return 1;
  }

  try {
    await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
      supervisorPid: identity.pid,
      supervisorUid: identity.uid,
      supervisorStartedAt: identity.startedAt,
      supervisorExecutable: identity.executable,
      supervisorCommand: identity.command,
    });
  } catch {
    return 2;
  }

  try {
    log = await createRuntimeLog(state.logFile, { assertTrustedDirectory });
    output = log.stream;
  } catch {
    await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
      state: "failed", errorCode: "RUNTIME_LOG_UNAVAILABLE", cleanup: "unconfirmed",
    }).catch(() => {});
    return 1;
  }

  let earlySignal = null;
  const earlySignalHandler = signal => { earlySignal = signal; };
  const earlySignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of earlySignals) process.on(signal, earlySignalHandler);

  let config;
  let credentialStore;
  try {
    config = await readSetupConfig(configFile, { platform });
    if (!TUNNEL_ID.test(config.tunnelId || "") || !config.tunnelClientPath) {
      throw supervisorError("CONFIG_INCOMPLETE");
    }
    credentialStore = createCredentialStore({ platform, env });
  } catch (error) {
    for (const signal of earlySignals) process.off(signal, earlySignalHandler);
    await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
      state: "failed", errorCode: error?.code || "CONFIG_INCOMPLETE", cleanup: "unconfirmed",
    }).catch(() => {});
    await log.end();
    return 1;
  }

  if (earlySignal) {
    for (const signal of earlySignals) process.off(signal, earlySignalHandler);
    await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
      state: "stopped", cleanup: "complete",
    }).catch(() => {});
    await log.end();
    return 0;
  }

  let tunnelReady = false;
  let runtime;
  try {
    runtime = await startForegroundRuntime({
      config,
      env,
      platform,
      credentialStore,
      stdout: output,
      stderr: output,
      startupTimeoutMs,
      healthPort: DEFAULT_HEALTH_PORT,
      onTunnelSpawned: async ({ pid, pgid }) => {
        if (earlySignal) throw supervisorError("RUNTIME_START_CANCELLED");
        await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
          tunnelPid: pid,
          tunnelPgid: pgid,
        });
      },
      onReady: async info => {
        const leader = await groupLeader(info.pid);
        await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
          state: "running",
          ownerVerified: true,
          tunnelPid: info.pid,
          tunnelUid: leader.uid,
          tunnelStartedAt: info.startedAt || leader.started_at,
          tunnelExecutable: normalizeExecutablePath(info.expectedExecutable || leader.executable || info.executable, platform),
          tunnelCommand: leader.command || config.tunnelClientPath,
          tunnelPgid: info.pgid,
        });
        tunnelReady = true;
      },
      onStopping: async () => {
        await updateRuntimeRecord(stateFile, instanceId, ["running"], { state: "stopping" }).catch(() => {});
      },
    });
  } catch (error) {
    for (const signal of earlySignals) process.off(signal, earlySignalHandler);
    if (error?.code === "RUNTIME_START_CANCELLED") {
      await updateRuntimeRecord(stateFile, instanceId, ["starting"], {
        state: "stopped", cleanup: "complete",
      }).catch(() => {});
    } else {
      const unconfirmed = ["RUNTIME_STOP_UNCONFIRMED", "RUNTIME_OWNER_UNKNOWN", "RUNTIME_OWNER_MISMATCH"]
        .includes(error?.code);
      await updateRuntimeRecord(stateFile, instanceId, ["starting", "running", "stopping"], {
        state: "failed",
        errorCode: error?.code || "RUNTIME_START_FAILED",
        cleanup: unconfirmed ? "unconfirmed" : "complete",
      }).catch(() => {});
    }
    logLine(output, `start failed: ${error?.code || error?.message || "unknown"}`);
    await log.end();
    return 1;
  }
  for (const signal of earlySignals) process.off(signal, earlySignalHandler);
  // A signal received while credentials were being read is not visible to the
  // foreground core yet. Re-deliver it after handlers are installed so cleanup
  // follows the normal stopping path.
  if (earlySignal) {
    try { process.kill(process.pid, earlySignal); } catch {}
  }

  const result = await runtime.waitForExit();
  if (!TERMINAL_STATES.has((await readRuntimeState(stateFile).catch(() => ({ state: "" }))).state)) {
    if (result?.code === "RUNTIME_STOPPED") {
      await updateRuntimeRecord(stateFile, instanceId, ["running", "stopping"], {
        state: "stopped", cleanup: "complete",
      }).catch(() => {});
    } else {
      await updateRuntimeRecord(stateFile, instanceId, ["running", "stopping"], {
        state: "failed",
        errorCode: result?.code || "RUNTIME_STOP_UNCONFIRMED",
        cleanup: result?.code === "RUNTIME_STOP_UNCONFIRMED" ? "unconfirmed" : "complete",
      }).catch(() => {});
    }
  }
  logLine(output, `runtime finished: ${result?.code || "unknown"}`);
  await log.end();
  return result?.exitCode === 0 ? 0 : 2;
}
