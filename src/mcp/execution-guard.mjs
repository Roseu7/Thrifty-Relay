import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { writeRecord } from "./task-storage.mjs";
import { processAdapter } from "../platform/index.mjs";
import { withAdmissionGate } from "./scope-leases.mjs";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const exists = file => fs.lstat(file).then(() => true, error => {
  if (error.code === "ENOENT") return false; throw error;
});
export function guardError(code) { throw Object.assign(new Error(code), { code }); }

// Process identity, its evidence, and termination live behind the platform adapter.
// The core only validates the caller's input, so no OS name appears here.
export async function probeProcesses(pids, descendants = false) {
  const ids = [...new Set(pids)];
  if (!ids.length || ids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) guardError("REMOTE_INVALID_PROCESS_ID");
  return processAdapter().probeProcesses(ids, descendants);
}

let owner;
export async function ownerIdentity() {
  owner ||= probeProcesses([process.pid]).then(rows => {
    const row = rows.find(item => item.pid === process.pid);
    if (!row?.started_at) guardError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE");
    return row;
  });
  return owner;
}

export async function lockSnapshot(file) {
  const bytes = await fs.readFile(file);
  let record = null;
  try { record = JSON.parse(bytes); } catch {}
  return { sha256: sha256(bytes), record };
}

export function createExecutionGuard({ dir }) {
  const store = path.join(dir, "codex");
  const active = path.join(store, "active.lock");
  const maintenance = path.join(store, "maintenance.lock");
  const marker = path.join(store, "coordination.json");
  async function enabled() {
    return !!process.env.THRIFTYRELAY_CODEX_WORKSPACE || await exists(marker) || await exists(active) || await exists(maintenance) ||
      await exists(path.join(store, "leases.json")) || await exists(path.join(store, "admission.lock"));
  }
  async function enable() {
    await fs.mkdir(store, { recursive: true });
    try { await writeRecord(marker, { version: 1, namespace: randomUUID(), enabled_at: new Date().toISOString() }, true); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    let control;
    try { control = JSON.parse(await fs.readFile(marker, "utf8")); } catch { guardError("REMOTE_COORDINATION_RECORD_UNREADABLE"); }
    if (control.version !== 1 || !control.namespace) guardError("REMOTE_COORDINATION_RECORD_UNREADABLE");
    return control;
  }
  async function acquire({ task_id, kind, cwd = null }) {
    const control = await enable();
    const processOwner = await ownerIdentity();
    return withAdmissionGate(store, async () => {
    if (await exists(maintenance)) guardError("REMOTE_MAINTENANCE_LOCKED");
    if (await exists(active)) guardError("REMOTE_EXECUTION_LOCKED");
    // Even a missing/damaged bridge must not admit a legacy writer over orphaned leases.
    try {
      const registry = JSON.parse(await fs.readFile(path.join(store, "leases.json"), "utf8"));
      if (registry.version !== 1 || registry.namespace !== control.namespace || !Array.isArray(registry.leases) ||
          registry.leases.length || registry.bridge) guardError("REMOTE_EXECUTION_LOCKED");
    } catch (error) { if (error.code !== "ENOENT") guardError("REMOTE_EXECUTION_LOCKED"); }
    const record = { version: 3, token: randomUUID(), namespace: control.namespace, task_id, kind, cwd,
      acquired_at: new Date().toISOString(), state: "running", processes: [], owner: processOwner };
    try { await writeRecord(active, record, true); }
    catch (error) { if (error.code === "EEXIST") guardError("REMOTE_EXECUTION_LOCKED"); throw error; }
    let updates = Promise.resolve();
    async function save() {
      if ((await lockSnapshot(active)).record?.token !== record.token) guardError("REMOTE_EXECUTION_LEASE_LOST");
      await writeRecord(active, record);
    }
    async function release() {
      await updates;
      if ((await lockSnapshot(active)).record?.token !== record.token) guardError("REMOTE_EXECUTION_LEASE_LOST");
      await fs.unlink(active);
    }
    if (await exists(maintenance)) { await release(); guardError("REMOTE_MAINTENANCE_LOCKED"); }
    return {
      record,
      noteProcess(pid, descendants = false) {
        updates = updates.then(async () => {
          const rows = await probeProcesses([pid], descendants);
          if (!rows.some(row => row.pid === pid)) rows.push({ pid, observed_absent_at: new Date().toISOString() });
          for (const row of rows) {
            if (!record.processes.some(old => old.pid === row.pid && old.started_at === row.started_at)) record.processes.push(row);
          }
          await save();
        });
        return updates;
      },
      async retain(reason) {
        await updates.catch(() => {});
        record.state = "unknown"; record.reason = reason; await save();
      },
      release,
    };
    });
  }
  return { enabled, enable, acquire, active, maintenance, marker };
}
