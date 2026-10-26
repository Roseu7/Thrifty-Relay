import { probeListeningProcessIds } from "./foreground.mjs";
import { probeProcesses } from "../mcp/execution-guard.mjs";
import { normalizeExecutablePath, taskAdapter, terminateProcessTree } from "../platform/index.mjs";

// Stop-ScheduledTask ends the launcher only. The tunnel and its MCP child are separate
// processes: leaving them behind keeps 127.0.0.1:8080 owned and makes the next start fail.
// The listener is terminated only when its executable is the configured tunnel client, so a
// different program that happens to hold 8080 is reported instead of killed.
export async function stopTaskRuntime({
  config,
  name,
  platform = process.platform,
  run,
  port = 8080,
  timeoutMs = 15_000,
  intervalMs = 500,
  probeOwner = probeListeningProcessIds,
  processProbe = probeProcesses,
  terminate = terminateProcessTree,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  try {
    await taskAdapter(platform).stopTask({ name });
  } catch (error) {
    throw Object.assign(new Error("TASK_STOP_FAILED"), { code: "TASK_STOP_FAILED", cause: error });
  }

  const expected = normalizeExecutablePath(config?.tunnelClientPath, platform);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const owners = await probeOwner(port, { run, platform }).catch(() => []);
    if (!owners.length) return { ok: true };
    for (const pid of owners) {
      const rows = await processProbe([pid], true).catch(() => []);
      const root = rows.find(row => row.pid === pid);
      if (!root?.executable) continue;
      if (normalizeExecutablePath(root.executable, platform) !== expected) continue;
      await terminate(pid, { run }, platform).catch(() => {});
    }
    if (Date.now() >= deadline) return { ok: false, code: "TASK_STOP_UNCONFIRMED" };
    await sleep(intervalMs);
  }
}
