import fs from "node:fs/promises";
import path from "node:path";
import { writeAudit } from "./approval.mjs";

// A submission that needs a window waits here. The record is the operation itself, not a flag:
// when the card approves, the task runs from this stored argument set, so what the card showed
// and what executes cannot drift apart. Claiming creates an exclusive name for the record,
// which is removed once the task is handed to the task manager.
//
// Expiry is part of claiming, not listing: a card left open past its ttl must not be spendable
// just because nobody asked for the list in the meantime. Every terminal path goes through one
// claim and then closePending(), which never claims again.

const PENDING_SUFFIX = ".json";
const CLAIMED_SUFFIX = ".claimed.json";
const DECISIONS_DIRECTORY = "decisions";
// An unanswered card should not sit around as an approval someone could spend much later.
export const PENDING_TTL_MS = 10 * 60_000;
// The decision is a short-lived answer ("declined", "expired"), not the audit trail. The audit
// log keeps the long history; this store only has to answer a card or an inspect that arrives
// shortly after the fact.
export const DECISION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_DECISIONS = 100;

export const CLOSE_OUTCOMES = new Set(["declined", "expired", "invalidated"]);

const pendingDirectory = directory => path.join(directory, "pending");
const decisionsDirectory = directory => path.join(directory, DECISIONS_DIRECTORY);
const pendingFile = (directory, taskId) => path.join(pendingDirectory(directory), taskId + PENDING_SUFFIX);
const claimedFile = (directory, taskId) => path.join(pendingDirectory(directory), taskId + CLAIMED_SUFFIX);
const decisionFile = (directory, taskId) => path.join(decisionsDirectory(directory), taskId + ".json");

async function readRecord(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// The body stays in args. A separate copy for display would be a second source of truth, so the
// card builds its description from the same steps the task will run.
export async function createPending({ directory, taskId, binding, args, scratchRoot = null, now = Date.now() }) {
  await fs.mkdir(pendingDirectory(directory), { recursive: true, mode: 0o700 });
  const record = {
    task_id: taskId,
    binding,
    created_at: new Date(now).toISOString(),
    scratch_root: typeof scratchRoot === "string" && scratchRoot ? scratchRoot : null,
    args,
  };
  const handle = await fs.open(pendingFile(directory, taskId), "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
  } finally {
    await handle.close();
  }
  return record;
}

export async function readPending({ directory, taskId }) {
  return readRecord(pendingFile(directory, taskId));
}

export async function readClaimed({ directory, taskId }) {
  return readRecord(claimedFile(directory, taskId));
}

// Creating the claimed hard link fails if the name already exists. Only the caller that
// creates it may remove the pending name and decide whether the submission is still valid.
export async function claimPending({ directory, taskId, now = Date.now(), ttlMs = PENDING_TTL_MS }) {
  // Both names stay in the same directory/filesystem. A failure to remove the old name leaves
  // a conflict that cannot be approved, rather than making the record available a second time.
  try {
    await fs.link(pendingFile(directory, taskId), claimedFile(directory, taskId));
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing", record: null };
    if (error.code === "EEXIST") {
      try { await fs.lstat(pendingFile(directory, taskId)); }
      catch (pendingError) {
        if (pendingError.code === "ENOENT") return { state: "missing", record: null };
        throw pendingError;
      }
      return { state: "conflict", record: null };
    }
    throw error;
  }
  await fs.unlink(pendingFile(directory, taskId));
  const record = await readRecord(claimedFile(directory, taskId));
  if (!record) return { state: "invalid", record: null };
  const created = Date.parse(record.created_at);
  // A record without a readable creation time is expired: a card that cannot say how old an
  // approval is must not be approvable.
  if (!(now - created < ttlMs)) return { state: "expired", record };
  return { state: "claimed", record };
}

async function writeDecision({ directory, taskId, decision }) {
  await fs.mkdir(decisionsDirectory(directory), { recursive: true, mode: 0o700 });
  const target = decisionFile(directory, taskId);
  const temporary = target + ".new";
  await fs.writeFile(temporary, JSON.stringify(decision), { mode: 0o600 });
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readDecision({ directory, taskId }) {
  const value = await readRecord(decisionFile(directory, taskId));
  if (!value || !CLOSE_OUTCOMES.has(value.outcome) || value.task_id !== taskId) return null;
  return value;
}

async function pruneDecisions({ directory, now = Date.now() }) {
  let names;
  try {
    names = await fs.readdir(decisionsDirectory(directory));
  } catch {
    return;
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(decisionsDirectory(directory), name);
    let at = Date.parse((await readRecord(file))?.at);
    if (!Number.isFinite(at)) {
      const stats = await fs.stat(file).catch(() => null);
      at = stats?.mtimeMs ?? now;
    }
    if (now - at > DECISION_RETENTION_MS) {
      await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }
    entries.push({ file, at });
  }
  if (entries.length <= MAX_DECISIONS) return;
  entries.sort((left, right) => right.at - left.at);
  for (const entry of entries.slice(MAX_DECISIONS)) await fs.rm(entry.file, { force: true }).catch(() => {});
}

// Terminal transitions call this with the record they already claimed. It never claims, so a
// caller that has validated the claim cannot lose it to a second rename halfway through.
export async function closePending({ directory, taskId, record = null, outcome, now = Date.now() }) {
  if (!CLOSE_OUTCOMES.has(outcome)) return { ok: false, error: "APPROVAL_OUTCOME_INVALID" };
  // A crash between the decision and the unlink leaves both records. The first decision is the
  // answer; a retry must not overwrite "declined" with "expired" just because it arrived later.
  const existing = await readDecision({ directory, taskId });
  if (existing) {
    await fs.rm(claimedFile(directory, taskId), { force: true }).catch(() => {});
    return { ok: true, decision: existing };
  }
  const decision = {
    task_id: taskId,
    outcome,
    at: new Date(now).toISOString(),
    binding: record?.binding ?? null,
  };
  try {
    await writeDecision({ directory, taskId, decision });
  } catch (error) {
    // The claimed file stays in place: the submission is not approvable, and a later call can
    // still record the reason instead of returning it to the card.
    return { ok: false, error: error?.code || "APPROVAL_DECISION_WRITE_FAILED" };
  }
  await fs.rm(claimedFile(directory, taskId), { force: true }).catch(() => {});
  await writeAudit({
    directory,
    entry: { at: decision.at, event: "pending." + outcome, task_id: taskId, binding: decision.binding },
  }).catch(() => {});
  await pruneDecisions({ directory, now }).catch(() => {});
  return { ok: true, decision };
}

// Expiry still claims first: an approval arriving at the same moment must either win the rename
// or find the record already terminal, never run between a read and a delete.
export async function expirePending({ directory, taskId, now = Date.now(), ttlMs = PENDING_TTL_MS }) {
  const claimed = await claimPending({ directory, taskId, now, ttlMs });
  if (claimed.state === "conflict") return { state: "conflict" };
  if (claimed.state === "missing") {
    const decision = await readDecision({ directory, taskId });
    return { state: decision ? decision.outcome : "missing", decision };
  }
  if (claimed.state === "claimed") {
    // Called speculatively for a record that is still valid: put it back rather than turning a
    // usable approval into a lost one.
    await restorePending({ directory, taskId }).catch(() => {});
    return { state: "claimed", record: claimed.record };
  }
  const closed = await closePending({ directory, taskId, record: claimed.record, outcome: "expired", now });
  return { state: "expired", decision: closed.decision ?? null, ok: closed.ok };
}

// Reading is not deleting. Callers that want the expired entries closed use expirePending(),
// which serializes with an approval through the same claim.
export async function scanPending({ directory, now = Date.now(), ttlMs = PENDING_TTL_MS }) {
  let names;
  try {
    names = await fs.readdir(pendingDirectory(directory));
  } catch {
    return { items: [], expired: [] };
  }
  const items = [];
  const expired = [];
  for (const name of names) {
    if (!name.endsWith(PENDING_SUFFIX) || name.endsWith(CLAIMED_SUFFIX)) continue;
    const file = path.join(pendingDirectory(directory), name);
    const record = await readRecord(file);
    const taskId = record?.task_id ?? name.slice(0, -PENDING_SUFFIX.length);
    if (!record) {
      expired.push({ task_id: taskId, record: null });
      continue;
    }
    if (!(now - Date.parse(record.created_at) < ttlMs)) {
      expired.push({ task_id: taskId, record });
      continue;
    }
    items.push(record);
  }
  return { items: items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), expired };
}

export async function listPending({ directory, now = Date.now(), ttlMs = PENDING_TTL_MS }) {
  return (await scanPending({ directory, now, ttlMs })).items;
}

// A refused window returns the submission to the card rather than losing it: the user still
// sees the operation and can approve again once the limit allows it.
export async function restorePending({ directory, taskId }) {
  await fs.rename(claimedFile(directory, taskId), pendingFile(directory, taskId));
}

export async function finishPending({ directory, taskId }) {
  await fs.rm(claimedFile(directory, taskId), { force: true });
}

// The root a submission was planned against is part of the operation: a restart that changes
// the temporary work area must not quietly move the write to a different tree. Only scratch
// submissions are tied to the root; ordinary paths keep their own admission decision.
export function scratchRootChanged({ record, currentRoot, samePath }) {
  if (!record || record.args?.scratch !== true) return false;
  if (typeof record.scratch_root !== "string" || record.scratch_root === "") return true;
  if (typeof currentRoot !== "string" || currentRoot === "") return true;
  return !samePath(record.scratch_root, currentRoot);
}
