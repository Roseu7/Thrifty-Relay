import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathsAdapter } from "../platform/index.mjs";
import { windowIsOpen } from "./access.mjs";

// A window is the only thing a card can create (design 2.6.3), and it must be spendable
// exactly once. Both properties are carried by the filesystem rather than by a flag a second
// caller could read before the first one writes: a window is one file, and spending it is a
// rename, which only one caller can win. The directory lives under the task store, which
// access.mjs already treats as protected (design 2.2.4).
//
// Counting concurrent windows and opening the next one share a lock, so two processes
// cannot both claim the last available slot.

const WINDOW_SUFFIX = ".json";
const LOCK_DIRECTORY = "state.lock";
const LOCK_TTL_MS = 15_000;
const LOCK_WAIT_MS = 5_000;

function approvalError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

const iso = now => new Date(now).toISOString();

// Audit entries use the host's local date.
export function dayKey(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function approvalDirectory({ platform = process.platform, env = process.env, home } = {}) {
  return path.join(pathsAdapter(platform).taskDirectory({ env, home }), "approval");
}

const windowsDirectory = directory => path.join(directory, "windows");
const auditFile = directory => path.join(directory, "audit.jsonl");
const windowFile = (directory, id, state = "open") => path.join(windowsDirectory(directory), id + (state === "open" ? "" : "." + state) + WINDOW_SUFFIX);

// The card shows facts the server derived, and the approval is bound to those facts (design
// 2.6.5). A stable encoding is what lets both sides compute the same value from the same
// display, so keys are sorted rather than trusted to arrive in an agreed order.
export function bindingHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}

async function appendAudit(directory, entry) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.appendFile(auditFile(directory), JSON.stringify(entry) + "\n", { mode: 0o600 });
}

// The admission layer records its refusals in the same log, so one file answers what the host
// was asked to do and what it declined.
export async function writeAudit({ directory, entry }) {
  await appendAudit(directory, entry);
}

// mkdir is the lock primitive every filesystem provides: creating the same directory twice
// fails for the second caller without a read-then-write gap. A lock left behind by a killed
// process is removed after a grace period, and the removal is recorded so a repeated stall is
// visible in the audit log instead of being silent.
async function withLock(directory, now, action) {
  const lock = path.join(directory, LOCK_DIRECTORY);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stats = await fs.stat(lock).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > LOCK_TTL_MS) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
        await appendAudit(directory, { at: iso(now), event: "approval.lock.stale" }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw approvalError("APPROVAL_BUSY");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    return await action();
  } finally {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

async function refuse(directory, now, error, fields = {}) {
  // A refused request is part of the record the design asks for, but a failure to write it
  // must not turn into permission: the refusal stands either way.
  await appendAudit(directory, {
    at: iso(now), event: "window.refused", day: dayKey(now), reason: error.code, ...fields,
  }).catch(() => {});
  throw error;
}

// The name is the state. A spent window's record is rewritten after the rename, so trusting
// the record alone would let a failure there make a spent window read as open again.
function stateOfName(name) {
  const base = name.slice(0, -WINDOW_SUFFIX.length);
  if (base.endsWith(".consumed")) return { state: "consumed", id: base.slice(0, -".consumed".length) };
  if (base.endsWith(".closed")) return { state: "closed", id: base.slice(0, -".closed".length) };
  return { state: "open", id: base };
}

// An unreadable window is not a usable one: it is skipped rather than repaired.
async function readWindows(directory) {
  let names;
  try {
    names = await fs.readdir(windowsDirectory(directory));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const windows = [];
  for (const name of names) {
    if (!name.endsWith(WINDOW_SUFFIX)) continue;
    const { state, id } = stateOfName(name);
    try {
      const value = JSON.parse(await fs.readFile(path.join(windowsDirectory(directory), name), "utf8"));
      if (!value || typeof value !== "object" || value.id !== id) continue;
      // A file that calls itself open under a spent name is a leftover, not a live approval.
      windows.push({ ...value, state: state === "open" && value.state !== "open" ? "invalid" : state });
    } catch {
      // ignored on purpose: the caller sees a host with fewer windows, which is the safe side.
    }
  }
  return windows;
}

// A window whose policy generation no longer matches was revoked by moving the registration
// forward (design 2.6.2): the file may still exist, but it grants nothing. Without a readable
// registration there is also nothing that could make a window usable.
export async function activeWindows({ directory, policy, now = Date.now() } = {}) {
  if (!Number.isInteger(policy?.generation)) return [];
  return (await readWindows(directory)).filter(window =>
    window.state === "open" && windowIsOpen(window, now) &&
    window.policy_generation === policy.generation);
}

// What a task may spend: the window it was approved with, still unexpired and from the same
// registration generation. Per-step admission asks this instead of keeping the tier in memory,
// so a kill switch, a revocation or an expiry applies to the rest of a running task too.
export async function approvalForTask({ directory, taskId, policy, now = Date.now() } = {}) {
  if (!policy || policy.kill_switch) return null;
  if (policy.full_access?.mode !== "window") return null;
  if (typeof taskId !== "string" || taskId === "") return null;
  const record = (await readWindows(directory))
    .filter(window => window.state === "consumed" && window.task_id === taskId).at(-1);
  // A spent window is proof only until the time it was approved for: windowIsOpen() speaks
  // about a window that may still be opened, so the expiry is read here instead.
  const expires = record ? Date.parse(record.expires_at) : NaN;
  if (!record || record.policy_generation !== policy.generation || !Number.isFinite(expires) || expires <= now) return null;
  return record;
}

export async function openWindow({ directory, policy, minutes, task = {}, binding = null, now = Date.now() } = {}) {
  const full = policy?.full_access;
  if (policy?.kill_switch) return refuse(directory, now, approvalError("APPROVAL_KILL_SWITCH"));
  if (full?.mode !== "window") return refuse(directory, now, approvalError("APPROVAL_WINDOW_NOT_PERMITTED", full?.mode ?? "policy-missing"));
  if (!Number.isInteger(policy?.generation)) return refuse(directory, now, approvalError("APPROVAL_WINDOW_NOT_PERMITTED", "policy-missing"));
  if (!Number.isInteger(minutes) || minutes < 1) return refuse(directory, now, approvalError("APPROVAL_WINDOW_INVALID"));
  if (minutes > full.max_minutes) return refuse(directory, now, approvalError("APPROVAL_WINDOW_TOO_LONG", full.max_minutes));
  // The window is spent by a task, so an approval that names none could never be consumed.
  if (typeof task.id !== "string" || task.id === "") return refuse(directory, now, approvalError("APPROVAL_TASK_REQUIRED"));
  // The approval covers what the card displayed, so the displayed set has to be sealed in.
  if (typeof binding !== "string" || binding === "") return refuse(directory, now, approvalError("APPROVAL_BINDING_REQUIRED"));

  return withLock(directory, now, async () => {
    if ((await activeWindows({ directory, policy, now })).length >= full.max_concurrent) {
      return refuse(directory, now, approvalError("APPROVAL_WINDOW_CONCURRENT_LIMIT", full.max_concurrent), { task_id: task.id });
    }

    const window = {
      id: randomBytes(16).toString("hex"),
      state: "open",
      opened_at: iso(now),
      expires_at: iso(now + minutes * 60_000),
      minutes,
      policy_generation: policy.generation,
      task_id: task.id,
      request_id: task.request_id ?? null,
      conversation_id: task.conversation_id ?? null,
      binding,
    };

    // An approval becomes usable only after its opening is recorded in the audit log.
    await appendAudit(directory, {
      at: iso(now), event: "window.opened", day: dayKey(now), window: window.id,
      minutes, expires_at: window.expires_at, task_id: window.task_id, binding,
    });

    await fs.mkdir(windowsDirectory(directory), { recursive: true, mode: 0o700 });
    const handle = await fs.open(windowFile(directory, window.id), "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(window));
    } finally {
      await handle.close();
    }
    return window;
  });
}

// Spending is the rename: the first caller moves the file away from the name every reader
// looks for, and the second one finds nothing to spend.
export async function consumeWindow({ directory, taskId, binding = null, policy, now = Date.now() } = {}) {
  // Consumption is the last moment before execution, so the registration is read again rather
  // than trusted from the moment the card was shown: a kill switch or a narrowed mode applies
  // to a window that is already open (design 2.6.8).
  if (!policy) return refuse(directory, now, approvalError("APPROVAL_WINDOW_NOT_PERMITTED", "policy-missing"), { task_id: taskId });
  if (policy.kill_switch) return refuse(directory, now, approvalError("APPROVAL_KILL_SWITCH"), { task_id: taskId });
  const mode = policy.full_access?.mode;
  if (mode !== "window" && mode !== "persistent") {
    return refuse(directory, now, approvalError("APPROVAL_WINDOW_NOT_PERMITTED", mode ?? "policy-denied"), { task_id: taskId });
  }

  return withLock(directory, now, async () => {
    const window = (await activeWindows({ directory, policy, now }))
      .filter(candidate => candidate.task_id === taskId).at(-1);
    if (!window) {
      // Telling a spent window apart from a missing one matters: a retry that reports "not
      // found" invites the model to ask for a new approval that it already has.
      const records = (await readWindows(directory)).filter(candidate => candidate.task_id === taskId);
      if (records.some(record => record.state === "consumed")) {
        return refuse(directory, now, approvalError("APPROVAL_WINDOW_ALREADY_CONSUMED", taskId));
      }
      return refuse(directory, now, approvalError(
        records.some(record => record.state === "open") ? "APPROVAL_WINDOW_REVOKED" : "APPROVAL_WINDOW_NOT_FOUND", taskId));
    }
    // The approval is bound to what was displayed; a caller that cannot present that exact
    // binding has no approval, including when the window was issued without one.
    if (typeof binding !== "string" || binding === "" || window.binding !== binding) {
      return refuse(directory, now, approvalError("APPROVAL_BINDING_MISMATCH", taskId), { window: window.id });
    }

    try {
      await fs.rename(windowFile(directory, window.id), windowFile(directory, window.id, "consumed"));
    } catch (error) {
      if (error.code === "ENOENT") return refuse(directory, now, approvalError("APPROVAL_WINDOW_ALREADY_CONSUMED", window.id));
      throw error;
    }
    // The spent name already carries the state, so a failure to rewrite the record cannot
    // resurrect the window.
    await fs.writeFile(windowFile(directory, window.id, "consumed"),
      JSON.stringify({ ...window, state: "consumed", consumed_at: iso(now) })).catch(() => {});
    await appendAudit(directory, { at: iso(now), event: "window.consumed", window: window.id, task_id: taskId, binding }).catch(() => {});
    return { ...window, state: "consumed", consumed_at: iso(now) };
  });
}

// Closing covers both "the task finished" and the remote side narrowing itself; the latter is
// the one permission change that is always safe (design 2.6.8).
export async function closeWindows({ directory, windowId = null, reason = "closed", now = Date.now() } = {}) {
  const windows = (await readWindows(directory))
    .filter(window => window.state === "open" && (windowId === null || window.id === windowId));
  for (const window of windows) {
    try {
      await fs.rename(windowFile(directory, window.id), windowFile(directory, window.id, "closed"));
      await fs.writeFile(windowFile(directory, window.id, "closed"),
        JSON.stringify({ ...window, state: "closed", closed_at: iso(now), reason })).catch(() => {});
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await appendAudit(directory, { at: iso(now), event: "window.closed", window: window.id, reason });
  }
  return windows.length;
}

// Health reports this so an unattended window is visible while it is still open (design 2.6.3).
export async function windowStatus({ directory, policy, now = Date.now() } = {}) {
  const active = await activeWindows({ directory, policy, now });
  return {
    open: active.length > 0,
    windows: active.map(window => ({
      id: window.id,
      task_id: window.task_id,
      expires_at: window.expires_at,
      remaining_ms: Math.max(0, Date.parse(window.expires_at) - now),
    })),
  };
}
