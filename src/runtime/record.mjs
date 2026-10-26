import { randomUUID } from "node:crypto";
import { readRuntimeState, writeRuntimeState } from "./state.mjs";

export const DEFAULT_HEALTH_PORT = 8080;

function recordError(code) {
  return Object.assign(new Error(code), { code });
}

export function createRuntimeRecord({
  instanceId = randomUUID(),
  mode,
  logFile,
  port = DEFAULT_HEALTH_PORT,
  createdAt = new Date().toISOString(),
} = {}) {
  return {
    version: 1,
    instanceId,
    state: "starting",
    mode,
    port,
    healthUrl: `http://127.0.0.1:${port}`,
    logFile,
    createdAt,
    supervisorPid: null,
    supervisorUid: null,
    supervisorStartedAt: null,
    supervisorExecutable: null,
    supervisorCommand: null,
    tunnelPid: null,
    tunnelUid: null,
    tunnelStartedAt: null,
    tunnelExecutable: null,
    tunnelCommand: null,
    tunnelPgid: null,
    ownerVerified: false,
    cleanup: null,
    errorCode: null,
  };
}

// The supervisor (or a foreground CLI acting as supervisor) is the only state
// writer after the parent writes `starting`. Re-read and check the instance and
// transition before every update so a replaced record is never overwritten.
export async function updateRuntimeRecord(file, instanceId, expectedStates, patch) {
  const current = await readRuntimeState(file);
  if (current.instanceId !== instanceId || !expectedStates.includes(current.state)) {
    throw recordError("RUNTIME_STATE_CONFLICT");
  }
  return writeRuntimeState(file, { ...current, ...patch });
}
