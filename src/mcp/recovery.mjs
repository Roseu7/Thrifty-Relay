import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createExecutionGuard, exists, lockSnapshot, probeProcesses, sha256, guardError } from "./execution-guard.mjs";
import { writeRecord } from "./task-storage.mjs";
import { createScopedLeaseRegistry } from "./scope-leases.mjs";
import { resolvesWithoutLink } from "./record-identity.mjs";
import { samePath } from "../platform/index.mjs";

const ID = /^task_[a-z0-9]+_[a-z0-9]{6}$/;
const sameProcess = (record, current) => current && record.started_at &&
  Date.parse(record.started_at) === Date.parse(current.started_at);
async function readTask(dir, id) {
  if (!ID.test(id || "")) guardError("REMOTE_INVALID_TASK_ID");
  try {
    const task = JSON.parse(await fs.readFile(path.join(dir, id + ".json"), "utf8"));
    if (task.id !== id) guardError("REMOTE_TASK_RECORD_MISMATCH");
    return task;
  }
  catch (error) { if (error.code === "ENOENT") return null; guardError("REMOTE_TASK_RECORD_UNREADABLE"); }
}

async function readRecordSnapshot(file, optional = false) {
  try {
    const before = await fs.lstat(file);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1 || !(await resolvesWithoutLink(file))) {
      guardError("REMOTE_RECOVERY_RECORD_UNAVAILABLE");
    }
    const bytes = await fs.readFile(file);
    const after = await fs.lstat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.nlink !== after.nlink || bytes.length !== after.size || !(await resolvesWithoutLink(file))) {
      guardError("REMOTE_RECOVERY_RECORD_CHANGED");
    }
    const record = JSON.parse(bytes.toString("utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) guardError("REMOTE_RECOVERY_RECORD_UNAVAILABLE");
    return { record, sha256: sha256(bytes) };
  } catch (error) {
    if (error?.code?.startsWith("REMOTE_")) throw error;
    if (optional && error?.code === "ENOENT") return null;
    guardError("REMOTE_RECOVERY_RECORD_UNAVAILABLE");
  }
}

function scopedMetadataPaths(dir, lease) {
  if (!ID.test(lease.task_id || "") || !/^cx_[a-f0-9]{32}$/.test(lease.conversation_id || "")) {
    guardError("REMOTE_SCOPED_RECORD_MISMATCH");
  }
  return {
    task: path.join(dir, lease.task_id + ".json"),
    request: path.join(dir, "codex", "requests", sha256(lease.request_id) + ".json"),
    conversation: path.join(dir, "codex", lease.conversation_id + ".json"),
  };
}

async function readScopedMetadata(dir, lease, expectedHashes, workspace) {
  const files = scopedMetadataPaths(dir, lease);
  const [task, request, conversation] = await Promise.all([
    readRecordSnapshot(files.task), readRecordSnapshot(files.request), readRecordSnapshot(files.conversation)
  ]);
  if (expectedHashes && (task.sha256 !== expectedHashes.task || request.sha256 !== expectedHashes.request ||
      conversation.sha256 !== expectedHashes.conversation)) guardError("REMOTE_LOCK_CHANGED");
  if (task.record.id !== lease.task_id || task.record.codex_request_id !== lease.request_id ||
      request.record.task_id !== lease.task_id || request.record.request_id !== lease.request_id ||
      request.record.conversation_id !== lease.conversation_id || conversation.record.id !== lease.conversation_id ||
      conversation.record.version !== 2 || typeof conversation.record.cwd !== "string" ||
      !samePath(conversation.record.cwd, workspace)) guardError("REMOTE_SCOPED_RECORD_MISMATCH");
  return { files, task, request, conversation,
    hashes: { task: task.sha256, request: request.sha256, conversation: conversation.sha256 } };
}

function matchingWorkerRows(lease, processes) {
  const byPid = new Map(processes.map(row => [row.pid, row]));
  const roots = new Set();
  for (const previous of lease.processes || []) {
    const now = byPid.get(previous.pid);
    if (!now) continue;
    const reusedAfterAbsence = previous.observed_absent_at && Date.parse(now.started_at) > Date.parse(previous.observed_absent_at);
    if (!reusedAfterAbsence && (!previous.started_at || Date.parse(previous.started_at) === Date.parse(now.started_at))) roots.add(now.pid);
  }
  if (!roots.size) return [];
  const live = new Set(roots);
  for (const row of processes) {
    let parent = row.parent_pid;
    for (let depth = 0; Number.isSafeInteger(parent) && parent > 0 && depth < 32; depth++) {
      if (roots.has(parent)) { live.add(row.pid); break; }
      parent = byPid.get(parent)?.parent_pid;
    }
  }
  return processes.filter(row => live.has(row.pid));
}

function processReviewFingerprint(processes) {
  const rows = processes.map(row => ({ pid: row.pid, parent_pid: row.parent_pid,
    started_at: row.started_at, executable: path.basename(row.executable || "unknown") }))
    .sort((left, right) => left.pid - right.pid);
  return sha256(JSON.stringify(rows));
}

async function verifyScopedStopped(dir, lease, expectedHashes, workspace) {
  const metadata = await readScopedMetadata(dir, lease, expectedHashes, workspace);
  const pids = [lease.owner.pid, ...(lease.processes || []).map(row => row.pid)]
    .filter((pid, index, all) => Number.isSafeInteger(pid) && pid > 0 && all.indexOf(pid) === index);
  const current = await probeProcesses(pids, true);
  const ownerNow = current.find(row => row.pid === lease.owner.pid);
  const ownerAlive = sameProcess(lease.owner, ownerNow);
  if (lease.state === "running" && ownerAlive) guardError("REMOTE_SCOPED_LEASE_OWNER_ACTIVE");
  if ((!metadata.task.record.finished_at || ["queued", "running"].includes(metadata.task.record.status)) && ownerAlive) {
    guardError("REMOTE_OWNER_TASK_STILL_ACTIVE");
  }
  const liveWorkers = matchingWorkerRows(lease, current);
  if (liveWorkers.length) guardError("REMOTE_OWNED_PROCESS_STILL_ALIVE");
  return { metadata, current_processes: current, live_worker_processes: liveWorkers,
    owner_alive: ownerAlive, checked_at: new Date().toISOString() };
}

export async function inspectScopedRecovery(dir, workspace) {
  const active = await exists(path.join(dir, "codex", "active.lock")) ?
    await lockSnapshot(path.join(dir, "codex", "active.lock")) : null;
  const root = workspace || process.env.THRIFTYRELAY_CODEX_WORKSPACE || active?.record?.workspace;
  if (!root) guardError("REMOTE_REGISTRY_UNAVAILABLE");
  const registry = createScopedLeaseRegistry({ dir, workspace: root });
  const snapshot = await registry.recoverySnapshot();
  const pids = snapshot.leases.flatMap(lease => [lease.owner.pid, ...(lease.processes || []).map(row => row.pid)])
    .filter((pid, index, all) => Number.isSafeInteger(pid) && pid > 0 && all.indexOf(pid) === index);
  const current = await probeProcesses(pids, true);
  const candidates = [];
  for (const lease of snapshot.leases) {
    const ownerAlive = sameProcess(lease.owner, current.find(row => row.pid === lease.owner.pid));
    const recoverable = lease.state === "unknown" || lease.state === "running" && !ownerAlive;
    if (!recoverable) {
      candidates.push({ task_id: lease.task_id, lease_id: lease.token, request_id: lease.request_id,
        conversation_id: lease.conversation_id, state: lease.state, recoverable: false, owner: lease.owner,
        owner_alive: ownerAlive, processes: lease.processes || [] });
      continue;
    }
    const metadata = await readScopedMetadata(dir, lease, undefined, snapshot.workspace);
    const expected = { ...snapshot,
      lease_id: lease.token,
      metadata_sha256: metadata.hashes,
    };
    candidates.push({ task_id: lease.task_id, lease_id: lease.token, request_id: lease.request_id,
      conversation_id: lease.conversation_id, state: lease.state, reason: lease.reason, owner: lease.owner,
      processes: lease.processes || [], task: { status: metadata.task.record.status,
        finished_at: metadata.task.record.finished_at || null, guard_state: metadata.task.record.guard_state },
      request_state: metadata.request.record.state, conversation_state: metadata.conversation.record.state,
      metadata_sha256: metadata.hashes, expected, owner_alive: ownerAlive, recoverable: true,
      live_worker_processes: matchingWorkerRows(lease, current) });
  }
  return { ...snapshot, candidates, current_processes: current,
    warning: "Detached or unrecorded process liveness cannot be fully proven by this snapshot; operator review remains required." };
}

export async function inspectRecovery(dir) {
  const guard = createExecutionGuard({ dir });
  const active = await exists(guard.active) ? await lockSnapshot(guard.active) : null;
  const maintenance = await exists(guard.maintenance) ? await lockSnapshot(guard.maintenance) : null;
  const record = active?.record;
  let scoped = { status: "uninitialized", lease_count: 0, unknown_count: 0, scope_bridge: false, admission_locked: false, leases: [] };
  const registryFile = path.join(dir, "codex", "leases.json");
  if (record?.type === "scope_bridge" || await exists(registryFile) || await exists(path.join(dir, "codex", "admission.lock"))) {
    try {
      const workspace = process.env.THRIFTYRELAY_CODEX_WORKSPACE || record?.workspace ||
        JSON.parse(await fs.readFile(registryFile, "utf8")).workspace;
      scoped = await createScopedLeaseRegistry({ dir, workspace }).inspect();
    } catch { scoped = { status: "unavailable", lease_count: null, unknown_count: null, scope_bridge: null, leases: [] }; }
  }
  const pids = [record?.owner?.pid, record?.owner_pid, ...(record?.processes || []).map(row => row.pid), maintenance?.record?.owner?.pid,
    ...scoped.leases.flatMap(lease => [lease.owner?.pid, ...lease.processes.map(row => row.pid)])]
    .filter(pid => Number.isSafeInteger(pid) && pid > 0);
  const current_processes = pids.length ? await probeProcesses(pids, true) : [];
  const task = record?.task_id ? await readTask(dir, record.task_id) : null;
  const requests = path.join(dir, "codex", "requests");
  const requestCount = await exists(requests) ? (await fs.readdir(requests)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length : 0;
  return { task_dir: dir, active, maintenance, scoped, current_processes,
    task: task ? { id: task.id, status: task.status, finished_at: task.finished_at, guard_state: task.guard_state, recovery: task.recovery } : null,
    retention: { request_tombstones: requestCount, request_expiration: "never", conversation_metadata: "retain; no automatic deletion",
      sdk_sessions: "owned by Codex; untouched", task_outputs: "latest 100, excluding unfinished/unknown/active-lock evidence" },
    warning: "Process evidence is incomplete for detached work. File/external-operation review and explicit human approval are mandatory." };
}

function validateApproval(approval) {
  if (!ID.test(approval.task_id || "") || !/^[a-f0-9]{64}$/.test(approval.lock_sha256 || "")) guardError("REMOTE_APPROVAL_INVALID");
  for (const key of ["owned_processes_stopped", "untracked_processes_reviewed", "files_reviewed", "external_operations_reviewed"]) {
    if (approval[key] !== true) guardError("REMOTE_APPROVAL_INCOMPLETE");
  }
  for (const key of ["approved_by", "approval_reference", "process_evidence", "file_evidence", "external_evidence"]) {
    if (typeof approval[key] !== "string" || approval[key].trim().length < (key === "approved_by" ? 1 : 10) || approval[key].length > 2000) guardError("REMOTE_APPROVAL_INCOMPLETE");
  }
  if (/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(JSON.stringify(approval))) guardError("REMOTE_APPROVAL_MUST_NOT_CONTAIN_SECRETS");
}

async function verifyStopped(dir, snapshot, approval) {
  const record = snapshot.record;
  if (record?.version === 3) {
    let control;
    try { control = JSON.parse(await fs.readFile(path.join(dir, "codex", "coordination.json"), "utf8")); }
    catch { guardError("REMOTE_STORE_NAMESPACE_MISMATCH"); }
    if (control.version !== 1 || control.namespace !== record.namespace) guardError("REMOTE_STORE_NAMESPACE_MISMATCH");
  }
  if (record?.task_id && record.task_id !== approval.task_id) guardError("REMOTE_APPROVAL_TASK_MISMATCH");
  if ((!record || record.version !== 3 || !record.owner?.started_at) && approval.legacy_or_incomplete_record_reviewed !== true) guardError("REMOTE_LEGACY_PROCESS_REVIEW_REQUIRED");
  const task = await readTask(dir, approval.task_id);
  const recordedOwner = record?.owner || (record?.owner_pid ? { pid: record.owner_pid } : null);
  const processes = record?.processes || [];
  const pids = [recordedOwner?.pid, ...processes.map(row => row.pid)].filter(pid => Number.isSafeInteger(pid) && pid > 0);
  const current = pids.length ? await probeProcesses(pids, true) : [];
  const ownerNow = current.find(row => row.pid === recordedOwner?.pid);
  const ownerAlive = recordedOwner && (recordedOwner.started_at ? sameProcess(recordedOwner, ownerNow) : !!ownerNow);
  if (ownerAlive && (!task?.finished_at || !(record?.state === "unknown" || task.guard_state === "unknown" || task.error || task.steps?.some(step => step.failed)))) guardError("REMOTE_OWNER_TASK_STILL_ACTIVE");
  for (const row of processes) {
    const now = current.find(item => item.pid === row.pid);
    const reusedAfterAbsence = row.observed_absent_at && now && Date.parse(now.started_at) > Date.parse(row.observed_absent_at);
    if (now && !reusedAfterAbsence && (!row.started_at || sameProcess(row, now))) guardError("REMOTE_OWNED_PROCESS_STILL_ALIVE");
  }
  // A live wrapper may be retained after a failed task. Other live descendants
  // of that wrapper must be reviewed manually; never kill them from this tool.
  return { task, current_processes: current, checked_at: new Date().toISOString() };
}

export async function recoverExecution({ dir, approval, confirm }) {
  validateApproval(approval);
  const guard = createExecutionGuard({ dir });
  if (await exists(guard.maintenance)) guardError("REMOTE_MAINTENANCE_LOCKED_INSPECT_REQUIRED");
  const snapshot = await lockSnapshot(guard.active);
  // The legacy approval/audit format cannot attest individual scoped leases.
  if (snapshot.record?.type === "scope_bridge" || await exists(path.join(dir, "codex", "admission.lock"))) {
    guardError("REMOTE_SCOPED_RECOVERY_UNAVAILABLE_ROLLOUT_BLOCKED");
  }
  try {
    const registry = JSON.parse(await fs.readFile(path.join(dir, "codex", "leases.json"), "utf8"));
    if (!Array.isArray(registry.leases) || registry.leases.length || registry.bridge) {
      guardError("REMOTE_SCOPED_RECOVERY_UNAVAILABLE_ROLLOUT_BLOCKED");
    }
  } catch (error) {
    if (error.code !== "ENOENT") guardError("REMOTE_SCOPED_RECOVERY_UNAVAILABLE_ROLLOUT_BLOCKED");
  }
  if (snapshot.sha256 !== approval.lock_sha256) guardError("REMOTE_LOCK_CHANGED");
  await verifyStopped(dir, snapshot, approval);
  if (!await confirm({ task_id: approval.task_id, lock_sha256: snapshot.sha256 })) guardError("REMOTE_HUMAN_APPROVAL_REQUIRED");

  const auditId = randomUUID();
  const maintenanceRecord = { version: 1, token: auditId, task_id: approval.task_id,
    owner: (await probeProcesses([process.pid])).find(row => row.pid === process.pid), created_at: new Date().toISOString() };
  if (!maintenanceRecord.owner?.started_at) guardError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE");
  try { await writeRecord(guard.maintenance, maintenanceRecord, true); }
  catch (error) { if (error.code === "EEXIST") guardError("REMOTE_MAINTENANCE_LOCKED_INSPECT_REQUIRED"); throw error; }
  let receipt, receiptFile, released = false;
  try {
    if ((await lockSnapshot(guard.active)).sha256 !== snapshot.sha256) guardError("REMOTE_LOCK_CHANGED");
    const review = await verifyStopped(dir, snapshot, approval);
    const auditDir = path.join(dir, "codex", "recovery");
    await fs.mkdir(auditDir, { recursive: true });
    receiptFile = path.join(auditDir, auditId + ".json");
    receipt = { version: 1, audit_id: auditId, decision: "approved_intent", at: new Date().toISOString(),
      task_id: approval.task_id, lock_sha256: snapshot.sha256, original_lock: snapshot.record,
      approval_sha256: sha256(JSON.stringify(approval)), approval, process_review: review.current_processes };
    await writeRecord(receiptFile, receipt, true);
    const task = review.task;
    if (task) {
      if (!task.finished_at) { task.status = "interrupted"; task.finished_at = new Date().toISOString(); }
      task.guard_state = "recovered";
      task.recovery = { audit_id: auditId, at: new Date().toISOString(), original_outcome_not_upgraded: true };
      await writeRecord(path.join(dir, approval.task_id + ".json"), task);
      if (task.codex_request_id) {
        const requestFile = path.join(dir, "codex", "requests", sha256(task.codex_request_id) + ".json");
        const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
        if (request.task_id !== task.id) guardError("REMOTE_REQUEST_TASK_MISMATCH");
        request.state = "reviewed_unknown"; request.recovery_audit_id = auditId;
        await writeRecord(requestFile, request);
        if (/^cx_[a-f0-9]{32}$/.test(request.conversation_id || "")) {
          const conversationFile = path.join(dir, "codex", request.conversation_id + ".json");
          if (await exists(conversationFile)) {
            const conversation = JSON.parse(await fs.readFile(conversationFile, "utf8"));
            conversation.state = "interrupted"; conversation.recovery_audit_id = auditId;
            await writeRecord(conversationFile, conversation);
          }
        }
      }
    }
    if ((await lockSnapshot(guard.active)).sha256 !== snapshot.sha256) guardError("REMOTE_LOCK_CHANGED");
    await fs.unlink(guard.active);
    released = true;
    receipt.decision = "released"; receipt.released_at = new Date().toISOString();
    await writeRecord(receiptFile, receipt);
    return { audit_id: auditId, decision: "released", task_id: approval.task_id, original_request_replayable: false };
  } catch (error) {
    if (receipt) {
      receipt.decision = released ? "released_audit_update_unconfirmed" : "failed_lock_retained";
      receipt.error = /^REMOTE_[A-Z_]+$/.test(error.code || "") ? error.code : "REMOTE_RECOVERY_FAILED";
      await writeRecord(receiptFile, receipt).catch(() => {});
    }
    throw error;
  } finally {
    if ((await lockSnapshot(guard.maintenance)).record?.token !== auditId) guardError("REMOTE_MAINTENANCE_LEASE_LOST");
    await fs.unlink(guard.maintenance);
  }
}

function validateScopedApproval(approval, lease, snapshot, expected) {
  if (!approval || approval.task_id !== lease.task_id || approval.lease_id !== lease.token ||
      approval.lease_state !== lease.state ||
      approval.namespace !== snapshot.namespace || approval.control_sha256 !== snapshot.control_sha256 ||
      approval.registry_sha256 !== snapshot.registry_sha256 || approval.bridge_sha256 !== snapshot.bridge_sha256 ||
      !expected?.metadata_sha256 || !["task", "request", "conversation"].every(key =>
        /^[a-f0-9]{64}$/.test(expected.metadata_sha256[key] || "") &&
        approval.metadata_sha256?.[key] === expected.metadata_sha256[key])) {
    guardError("REMOTE_APPROVAL_INVALID");
  }
  for (const key of ["owned_processes_stopped", "untracked_processes_reviewed", "files_reviewed", "external_operations_reviewed"]) {
    if (approval[key] !== true) guardError("REMOTE_APPROVAL_INCOMPLETE");
  }
  for (const key of ["approved_by", "approval_reference", "process_evidence", "file_evidence", "external_evidence"]) {
    if (typeof approval[key] !== "string" || approval[key].trim().length < (key === "approved_by" ? 1 : 10) || approval[key].length > 2000) {
      guardError("REMOTE_APPROVAL_INCOMPLETE");
    }
  }
  if (/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(JSON.stringify(approval))) {
    guardError("REMOTE_APPROVAL_MUST_NOT_CONTAIN_SECRETS");
  }
}

function assertScopedSnapshotMatches(actual, expected, leaseId, taskId) {
  if (actual.namespace !== expected.namespace || actual.control_sha256 !== expected.control_sha256 ||
      actual.registry_sha256 !== expected.registry_sha256 || actual.bridge_sha256 !== expected.bridge_sha256 ||
      actual.bridge_token !== expected.bridge_token) guardError("REMOTE_LOCK_CHANGED");
  const lease = actual.leases.find(item => item.token === leaseId);
  const previous = expected.leases?.find(item => item.token === leaseId && item.task_id === taskId);
  if (!lease || lease.task_id !== taskId || !["unknown", "running"].includes(lease.state) ||
      lease.state !== previous?.state || actual.leases.length !== 1 || !previous) {
    if (actual.leases.length > 1) guardError("REMOTE_SCOPED_OTHER_LEASES_ACTIVE");
    guardError("REMOTE_LOCK_CHANGED");
  }
  return lease;
}

export async function recoverScopedLease({ dir, expected, task_id, lease_id, approval, confirm, presentReview }) {
  const registry = createScopedLeaseRegistry({ dir, workspace: expected?.workspace });
  const current = await registry.recoverySnapshot();
  const lease = assertScopedSnapshotMatches(current, expected, lease_id, task_id);
  validateScopedApproval(approval, lease, current, expected);
  if (typeof confirm !== "function" || typeof presentReview !== "function") guardError("REMOTE_HUMAN_APPROVAL_REQUIRED");

  const firstReview = await verifyScopedStopped(dir, lease, expected.metadata_sha256, expected.workspace);
  await presentReview(firstReview);
  approval.process_evidence = `Refreshed process probe at ${firstReview.checked_at}; owner_alive=${firstReview.owner_alive}; rows=${firstReview.current_processes.length}; no recorded worker identity was observed alive. Detached and unrecorded work remains outside machine proof. Operator manually reviewed the displayed refreshed process evidence.`;
  validateScopedApproval(approval, lease, current, expected);
  if (!await confirm({ task_id, lease_id, namespace: current.namespace,
    registry_sha256: current.registry_sha256, bridge_sha256: current.bridge_sha256 })) {
    guardError("REMOTE_HUMAN_APPROVAL_REQUIRED");
  }

  const auditId = randomUUID();
  const auditDir = path.join(dir, "codex", "recovery");
  try { await fs.mkdir(auditDir, { recursive: true }); }
  catch { guardError("REMOTE_RECOVERY_AUDIT_UNAVAILABLE"); }
  const auditStats = await fs.lstat(auditDir).catch(() => null);
  if (!auditStats.isDirectory() || auditStats.isSymbolicLink() || !(await resolvesWithoutLink(auditDir))) {
    guardError("REMOTE_RECOVERY_AUDIT_UNAVAILABLE");
  }
  const receiptFile = path.join(auditDir, auditId + ".json");
  const receipt = {
    version: 1, audit_id: auditId, recovery_type: "scoped_lease", decision: "approved_intent",
    at: new Date().toISOString(), task_id, lease_id, request_id: lease.request_id,
    conversation_id: lease.conversation_id, namespace: current.namespace,
    control_sha256: current.control_sha256, registry_sha256: current.registry_sha256,
    bridge_sha256: current.bridge_sha256, metadata_sha256: expected.metadata_sha256,
    original_lease: lease, approval_sha256: sha256(JSON.stringify(approval)), approval,
    process_review: firstReview.current_processes.map(row => ({ pid: row.pid, parent_pid: row.parent_pid,
      started_at: row.started_at, executable: path.basename(row.executable || "unknown") })),
    process_evidence_limit: "Detached or unrecorded work cannot be fully observed; operator attestation is required.",
  };
  try { await writeRecord(receiptFile, receipt, true); }
  catch { guardError("REMOTE_RECOVERY_AUDIT_UNAVAILABLE"); }

  let recoveryPendingTaskHash;
  let released = false;
  try {
    await registry.recoverSelectedLease({ task_id, lease_id, expected,
      beforeRelease: async freshLease => {
        const review = await verifyScopedStopped(dir, freshLease, expected.metadata_sha256, expected.workspace);
        if (processReviewFingerprint(review.current_processes) !== processReviewFingerprint(firstReview.current_processes)) {
          guardError("REMOTE_PROCESS_EVIDENCE_CHANGED");
        }
        const { task, request, conversation, files, hashes } = review.metadata;

        const updatedRequest = { ...request.record, state: "reviewed_unknown",
          recovery_audit_id: auditId, reviewed_unknown_from: request.record.state };
        const updatedConversation = { ...conversation.record, state: "interrupted", recovery_audit_id: auditId };
        const updatedTask = { ...task.record, status: "interrupted", finished_at: task.record.finished_at || new Date().toISOString(),
          execution_unknown: true, guard_state: "unknown",
          recovery_pending: { audit_id: auditId, at: new Date().toISOString(), original_outcome_not_upgraded: true } };
        delete updatedTask.recovery;

        const saveVerified = async (file, value, expectedHash) => {
          const latest = await readRecordSnapshot(file);
          if (latest.sha256 !== expectedHash) guardError("REMOTE_LOCK_CHANGED");
          await writeRecord(file, value);
        };
        await saveVerified(files.request, updatedRequest, hashes.request);
        await saveVerified(files.conversation, updatedConversation, hashes.conversation);
        await saveVerified(files.task, updatedTask, hashes.task);
        recoveryPendingTaskHash = (await readRecordSnapshot(files.task)).sha256;
        receipt.reviewed_at = review.checked_at;
        receipt.process_review = review.current_processes.map(row => ({ pid: row.pid, parent_pid: row.parent_pid,
          started_at: row.started_at, executable: path.basename(row.executable || "unknown") }));
        receipt.task_status_before_release = "interrupted";
        receipt.task_guard_state_before_release = "unknown";
        receipt.request_state_after_recovery = "reviewed_unknown";
        receipt.conversation_state_after_recovery = "interrupted";
      },
      onReleaseStart: async () => {
        receipt.decision = "release_in_progress";
        receipt.release_started_at = new Date().toISOString();
        await writeRecord(receiptFile, receipt);
      },
    });
    released = true;
  } catch (error) {
    receipt.decision = error.recovery_lock_state === "retained" ? "failed_lock_retained" : "failed_lock_state_unconfirmed";
    receipt.recovery_lock_state = error.recovery_lock_state || "unknown";
    receipt.error = /^REMOTE_[A-Z_]+$/.test(error.code || "") ? error.code : "REMOTE_RECOVERY_FAILED";
    receipt.failed_at = new Date().toISOString();
    error.audit_id ||= auditId;
    await writeRecord(receiptFile, receipt).catch(() => { error.audit_update_unconfirmed = true; });
    throw error;
  }

  if (released) {
    try {
      const taskFile = path.join(dir, task_id + ".json");
      const taskSnapshot = await readRecordSnapshot(taskFile);
      if (!recoveryPendingTaskHash || taskSnapshot.sha256 !== recoveryPendingTaskHash ||
          taskSnapshot.record.recovery_pending?.audit_id !== auditId) guardError("REMOTE_LOCK_CHANGED");
      const recoveredTask = { ...taskSnapshot.record, guard_state: "recovered",
        recovery: { audit_id: auditId, at: new Date().toISOString(), original_outcome_not_upgraded: true } };
      delete recoveredTask.recovery_pending;
      await writeRecord(taskFile, recoveredTask);
      receipt.task_status_after_recovery = "interrupted";
      receipt.task_guard_state_after_recovery = "recovered";
    } catch {
      receipt.decision = "released_task_update_unconfirmed";
      receipt.error = "REMOTE_RECOVERY_POST_RELEASE_RECORD_FAILED";
      receipt.released_at = new Date().toISOString();
      const error = Object.assign(new Error("REMOTE_RECOVERY_POST_RELEASE_RECORD_FAILED"),
        { code: "REMOTE_RECOVERY_POST_RELEASE_RECORD_FAILED", audit_id: auditId, released: true });
      await writeRecord(receiptFile, receipt).catch(() => { error.audit_update_unconfirmed = true; });
      throw error;
    }
    receipt.decision = "released";
    receipt.released_at = new Date().toISOString();
    try { await writeRecord(receiptFile, receipt); }
    catch {
      receipt.decision = "released_audit_update_unconfirmed";
      receipt.error = "REMOTE_RECOVERY_AUDIT_UPDATE_FAILED";
      receipt.audit_update_failed_at = new Date().toISOString();
      const error = Object.assign(new Error("REMOTE_RECOVERY_AUDIT_UPDATE_FAILED"),
        { code: "REMOTE_RECOVERY_AUDIT_UPDATE_FAILED", audit_id: auditId, released: true });
      await writeRecord(receiptFile, receipt).catch(() => { error.audit_update_unconfirmed = true; });
      throw error;
    }
  }
  return { audit_id: auditId, decision: "released", task_id, lease_id,
    original_request_replayable: false, original_outcome_not_upgraded: true };
}
