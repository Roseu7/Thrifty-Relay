import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeExecutablePath, probeProcessCommand, probeProcessGroup } from "../platform/index.mjs";
import { probeProcesses } from "../mcp/execution-guard.mjs";
import { bindProbe } from "./listener.mjs";
import { acquireRuntimeLock } from "./lock.mjs";
import { createRuntimeRecord, updateRuntimeRecord, DEFAULT_HEALTH_PORT } from "./record.mjs";
import { resolveStartConflict } from "./background.mjs";
import { LOG_FILE_NAME } from "./log.mjs";
import {
  STATE_FILE_NAME, ensureRuntimeDirectory, readRuntimeState, runtimeDirectory, writeRuntimeState,
} from "./state.mjs";
import { startForegroundRuntime } from "./foreground.mjs";

function foregroundError(code) {
  return Object.assign(new Error(code), { code });
}

async function ownIdentity(platform) {
  const rows = await probeProcesses([process.pid]);
  const row = rows.find(item => item.pid === process.pid);
  if (!row?.started_at) throw foregroundError("RUNTIME_OWNER_UNKNOWN");
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

async function groupLeader(pid, platform) {
  const rows = await probeProcessGroup(pid, undefined, platform);
  const leader = rows.find(row => row.pid === pid);
  if (!leader) throw foregroundError("RUNTIME_OWNER_UNKNOWN");
  return leader;
}

// A foreground CLI is its own supervisor. It writes the same record as the
// background daemon so `stop` and the next `start` can verify and reclaim it.
export async function startForegroundRuntimeWithRecord({
  config,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  stateFile = null,
  directory = null,
  runtimeStarter = startForegroundRuntime,
  runtimeOptions = {},
  packageRoot,
  processRef = process,
  processProbe = probeProcesses,
  bindPort = bindProbe,
  probeGroup = pgid => probeProcessGroup(pgid, undefined, platform),
  ...starterOptions
} = {}) {
  if (platform === "win32") throw foregroundError("REMOTE_PLATFORM_UNSUPPORTED");
  if (process.geteuid?.() === 0) throw foregroundError("RUNTIME_AS_ROOT");
  if (!config || typeof config.workspace !== "string" || !path.posix.isAbsolute(config.workspace) ||
      typeof config.taskDirectory !== "string" || !path.posix.isAbsolute(config.taskDirectory)) {
    throw foregroundError("RUNTIME_CONFIG_INVALID");
  }
  const runtimeDir = directory || runtimeDirectory({ platform, env, home });
  await ensureRuntimeDirectory(runtimeDir);
  const file = stateFile || path.posix.join(runtimeDir, STATE_FILE_NAME);
  const logFile = path.posix.join(runtimeDir, LOG_FILE_NAME);
  let expectedTunnelExecutable;
  try {
    expectedTunnelExecutable = await fs.realpath(config.tunnelClientPath);
    await fs.access(expectedTunnelExecutable, fs.constants.X_OK);
  } catch {
    throw foregroundError("RUNTIME_CONFIG_INVALID");
  }

  const lock = await acquireRuntimeLock(runtimeDir);
  let instanceId;
  let releaseLock = () => lock.release().catch(() => {});
  try {
    const existing = await readRuntimeState(file);
    if (existing) await resolveStartConflict(existing, {
      stateFile: file, processProbe, bindPort, probeGroup, expectedTunnelExecutable, platform,
    });
    const record = createRuntimeRecord({
      instanceId: randomUUID(),
      mode: "foreground",
      logFile,
      port: DEFAULT_HEALTH_PORT,
    });
    instanceId = record.instanceId;
    await writeRuntimeState(file, record);
    const identity = await ownIdentity(platform);
    await updateRuntimeRecord(file, instanceId, ["starting"], {
      supervisorPid: identity.pid,
      supervisorUid: identity.uid,
      supervisorStartedAt: identity.startedAt,
      supervisorExecutable: identity.executable,
      supervisorCommand: identity.command,
    });

    let runtime;
    try {
      runtime = await runtimeStarter({
        ...runtimeOptions,
        ...starterOptions,
        config,
        env,
        platform,
        packageRoot,
        processRef,
        onTunnelSpawned: async ({ pid, pgid }) => {
          await updateRuntimeRecord(file, instanceId, ["starting"], {
            tunnelPid: pid,
            tunnelPgid: pgid,
          });
          await releaseLock();
        },
        onReady: async info => {
          const leader = await groupLeader(info.pid, platform);
          await updateRuntimeRecord(file, instanceId, ["starting"], {
            state: "running",
            ownerVerified: true,
            tunnelPid: info.pid,
            tunnelUid: leader.uid,
            tunnelStartedAt: info.startedAt || leader.started_at,
            tunnelExecutable: normalizeExecutablePath(info.expectedExecutable || leader.executable || info.executable, platform),
            tunnelCommand: leader.command || config.tunnelClientPath,
            tunnelPgid: info.pgid,
          });
        },
        onStopping: async () => {
          await updateRuntimeRecord(file, instanceId, ["running"], { state: "stopping" }).catch(() => {});
        },
      });
    } catch (error) {
      const cancelled = error?.code === "RUNTIME_START_CANCELLED";
      const unconfirmed = ["RUNTIME_STOP_UNCONFIRMED", "RUNTIME_OWNER_UNKNOWN", "RUNTIME_OWNER_MISMATCH"]
        .includes(error?.code);
      await updateRuntimeRecord(file, instanceId, ["starting", "running", "stopping"], cancelled ? {
        state: "stopped", cleanup: "complete",
      } : {
        state: "failed",
        errorCode: error?.code || "RUNTIME_START_FAILED",
        cleanup: unconfirmed ? "unconfirmed" : "complete",
      }).catch(() => {});
      throw error;
    }

    const waitForExit = runtime.waitForExit.bind(runtime);
    return {
      ...runtime,
      async waitForExit(options) {
        const result = await waitForExit(options);
        if (result?.code === "RUNTIME_STOPPED") {
          await updateRuntimeRecord(file, instanceId, ["running", "stopping"], {
            state: "stopped", cleanup: "complete",
          }).catch(() => {});
        } else {
          await updateRuntimeRecord(file, instanceId, ["running", "stopping"], {
            state: "failed",
            errorCode: result?.code || "RUNTIME_STOP_UNCONFIRMED",
            cleanup: result?.code === "RUNTIME_STOP_UNCONFIRMED" ? "unconfirmed" : "complete",
          }).catch(() => {});
        }
        return result;
      },
    };
  } finally {
    await releaseLock();
  }
}
