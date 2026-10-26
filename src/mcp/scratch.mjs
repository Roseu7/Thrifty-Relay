import fs from "node:fs/promises";
import path from "node:path";

// A scratch directory is disposable, but it is still owned data: cleanup must never turn a
// failed or unresolved task into a clean success by deleting its evidence. Every directory
// this module deletes is a direct child of the configured root, carries an owner record that
// matches its name, and is not a link.

export const SCRATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SCRATCH_ENTRIES = 100;
export const MAX_SCRATCH_BYTES = 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 20_000;

function scratchError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

function flavour(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function defaultPattern() {
  return /^task_[a-z0-9]+_[a-z0-9]{6}$/;
}

export function taskScratchPath(root, taskId, { platform = process.platform, idPattern = defaultPattern() } = {}) {
  if (typeof taskId !== "string" || !idPattern.test(taskId)) throw scratchError("SCRATCH_TASK_ID_INVALID", taskId);
  return flavour(platform).join(root, taskId);
}

async function writeOwner(directory, taskId, now, platform, fsApi) {
  const ownerFile = flavour(platform).join(directory, "owner.json");
  let handle;
  try {
    handle = await fsApi.open(ownerFile, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try { owner = JSON.parse(await fsApi.readFile(ownerFile, "utf8")); }
    catch { throw scratchError("SCRATCH_OWNER_CONFLICT", directory); }
    if (owner?.task_id !== taskId) throw scratchError("SCRATCH_OWNER_CONFLICT", directory);
    return;
  }
  try {
    await handle.writeFile(JSON.stringify({
      version: 1, task_id: taskId, created_at: new Date(now).toISOString(),
    }));
  } finally {
    await handle.close();
  }
}

export async function createTaskScratch({
  root, taskId, platform = process.platform, idPattern = defaultPattern(), now = Date.now(), fsApi = fs,
} = {}) {
  if (typeof root !== "string" || !flavour(platform).isAbsolute(root)) throw scratchError("SCRATCH_ROOT_INVALID");
  const directory = taskScratchPath(root, taskId, { platform, idPattern });
  try {
    await fsApi.mkdir(root, { recursive: true, mode: 0o700 });
    await fsApi.mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await writeOwner(directory, taskId, now, platform, fsApi);
  return directory;
}

// Relative paths in a scratch task are resolved inside that task's own directory. Absolute
// paths are left alone and still pass through admission, so this does not create a second
// permission rule. A relative path that climbs out is refused rather than silently becoming a
// sibling task's path.
export function resolveScratchStep(step, directory, { platform = process.platform, strict = true } = {}) {
  if (!step || typeof step !== "object" || !directory) return step;
  const flavourPath = flavour(platform);
  const base = flavourPath.resolve(directory);
  const inside = target => {
    const relative = flavourPath.relative(base, target);
    return relative === "" ||
      (relative !== ".." && !relative.startsWith(".." + flavourPath.sep) && !flavourPath.isAbsolute(relative));
  };
  const expand = value => typeof value === "string" ? value.replaceAll("{{scratch}}", directory) : value;
  const resolve = value => {
    const expanded = expand(value);
    if (typeof expanded !== "string" || !expanded) return expanded;
    const absolute = flavourPath.isAbsolute(expanded);
    const resolved = absolute ? flavourPath.normalize(expanded) : flavourPath.resolve(base, expanded);
    // The token names this task's directory, so it must not be used to climb back out of it.
    // An absolute path the caller supplied directly is still an ordinary admission decision.
    const token = typeof value === "string" && value.includes("{{scratch}}");
    if (strict && (token || !absolute) && !inside(resolved)) {
      throw scratchError("SCRATCH_PATH_ESCAPE", value);
    }
    return resolved;
  };
  const next = { ...step };
  if (Object.hasOwn(next, "path")) next.path = resolve(next.path);
  if (Object.hasOwn(next, "file_path")) next.file_path = resolve(next.file_path);
  if (Object.hasOwn(next, "cwd")) next.cwd = resolve(next.cwd);
  if (Array.isArray(next.files)) {
    next.files = next.files.map(file => file && typeof file === "object" && Object.hasOwn(file, "path")
      ? { ...file, path: resolve(file.path) } : file);
  }
  // Shell steps cannot take a cwd, so the token is the only way to name the directory
  // without knowing the task id before submission. The caller supplies any quoting it needs.
  if (typeof next.command === "string") next.command = expand(next.command);
  return next;
}

export function scratchOutcome(task = {}) {
  if (!task || typeof task !== "object") return "keep";
  // A recovered task is not a success: its original outcome was never upgraded, and the
  // directory may be the only remaining local evidence of what the worker wrote.
  if (task.guard_state === "unknown" || task.guard_state === "recovered") return "protect";
  if (task.recovery || task.recovery_pending) return "protect";
  if (task.execution_unknown) return "protect";
  // A record without finished_at is either active or was interrupted before it could say how
  // it ended. Both are evidence, not a disposable failure.
  if (!task.finished_at) return "protect";
  if (task.status === "succeeded") return "remove";
  return "keep";
}

async function readOwner(directory, platform, fsApi) {
  try {
    const owner = JSON.parse(await fsApi.readFile(flavour(platform).join(directory, "owner.json"), "utf8"));
    return owner && typeof owner === "object" ? owner : null;
  } catch {
    return null;
  }
}

// The task store is the only place that says how a directory ended. "Missing" means the store
// no longer describes it; "unreadable" means the store may describe an unresolved task whose
// evidence is still needed, so the two must not collapse into the same deletable state.
async function readTask(taskDirectory, taskId, platform, fsApi) {
  if (!taskDirectory) return { status: "unreadable", code: "SCRATCH_TASK_RECORD_UNAVAILABLE" };
  let source;
  try {
    source = await fsApi.readFile(flavour(platform).join(taskDirectory, taskId + ".json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { status: "missing" };
    return { status: "unreadable", code: error.code || "SCRATCH_TASK_RECORD_UNREADABLE" };
  }
  let record;
  try { record = JSON.parse(source); }
  catch { return { status: "unreadable", code: "SCRATCH_TASK_RECORD_INVALID" }; }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { status: "unreadable", code: "SCRATCH_TASK_RECORD_INVALID" };
  }
  return { status: "record", record };
}

// Size accounting must not follow links, and a hostile tree must not make cleanup walk
// forever. Entries beyond the budget count as large so the caller stops trusting the size
// accounting instead of deleting more than it can inspect.
async function directorySize(directory, fsApi, budget, platform) {
  const flavourPath = flavour(platform);
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fsApi.readdir(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (budget.entries-- <= 0) return { bytes: total, truncated: true };
      const child = flavourPath.join(current, entry.name);
      let stats;
      try { stats = await fsApi.lstat(child); }
      catch { continue; }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) pending.push(child);
      else if (stats.isFile()) total += stats.size;
      if (total >= budget.bytes) return { bytes: total, truncated: false };
    }
  }
  return { bytes: total, truncated: false };
}

async function isDirectChild(root, directory, platform, fsApi) {
  try {
    const [realRoot, realDirectory, stats] = await Promise.all([
      fsApi.realpath(root), fsApi.realpath(directory), fsApi.lstat(directory),
    ]);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const norm = value => platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
    return norm(flavour(platform).dirname(realDirectory)) === norm(flavour(platform).normalize(realRoot));
  } catch {
    return false;
  }
}

// Cleanup runs on every task completion. It removes the current task's directory on a
// confirmed success, keeps failures for the retention period, and never touches a directory
// that belongs to an active, unresolved, interrupted, or recovered task, or whose task record
// cannot be read well enough to rule those out.
export async function cleanupScratch({
  root,
  task = null,
  activeIds = [],
  taskDirectory = null,
  platform = process.platform,
  idPattern = defaultPattern(),
  now = Date.now(),
  retentionMs = SCRATCH_RETENTION_MS,
  maxEntries = MAX_SCRATCH_ENTRIES,
  maxBytes = MAX_SCRATCH_BYTES,
  fsApi = fs,
} = {}) {
  if (typeof root !== "string" || !flavour(platform).isAbsolute(root)) {
    return { removed: [], kept: [], protected: [], unavailable: true };
  }
  // The configured root itself must be a real directory. Following a replaced root link
  // would let cleanup reach a tree the owner records do not describe.
  let rootStats;
  try { rootStats = await fsApi.lstat(root); }
  catch (error) {
    if (error.code === "ENOENT") return { removed: [], kept: [], protected: [], unavailable: false };
    throw error;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return { removed: [], kept: [], protected: [], unavailable: true };
  }
  let names;
  try { names = await fsApi.readdir(root); }
  catch (error) {
    if (error.code === "ENOENT") return { removed: [], kept: [], protected: [], unavailable: false };
    throw error;
  }

  const removed = [];
  const kept = [];
  const protectedIds = [];
  const candidates = [];
  const active = new Set(activeIds);

  for (const name of names) {
    if (!idPattern.test(name)) continue;
    const directory = flavour(platform).join(root, name);
    let stats;
    try { stats = await fsApi.lstat(directory); }
    catch { continue; }
    // A link is never followed: its target may be a user directory or another task's data.
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    if (!await isDirectChild(root, directory, platform, fsApi)) continue;
    const owner = await readOwner(directory, platform, fsApi);
    if (!owner || owner.task_id !== name) {
      protectedIds.push(name);
      kept.push(name);
      continue;
    }

    let outcome;
    if (active.has(name)) {
      // A running task can outgrow any cap, so it must not be a candidate for either budget:
      // keeping it out of the sweep is what makes the cap unable to delete live data.
      outcome = "protect";
    } else {
      const stored = task && task.id === name
        ? { status: "record", record: task }
        : await readTask(taskDirectory, name, platform, fsApi);
      // Only a record the store proves absent is disposable as an orphan. A record that exists
      // but cannot be read or parsed may still name an unresolved task, so it is evidence.
      if (stored.status === "unreadable") outcome = "protect";
      else if (stored.status === "record") outcome = scratchOutcome(stored.record);
      else outcome = "orphan";
    }
    if (outcome === "remove") {
      try {
        await fsApi.rm(directory, { recursive: true, force: true });
        removed.push(name);
      } catch {
        kept.push(name);
      }
      continue;
    }
    if (outcome === "protect") {
      protectedIds.push(name);
      kept.push(name);
      continue;
    }
    const createdAt = Date.parse(owner.created_at);
    const size = await directorySize(directory, fsApi, { entries: MAX_TREE_ENTRIES, bytes: maxBytes }, platform);
    candidates.push({
      name, directory, protected: false,
      // A tree too large or too deep to inspect is treated as over budget rather than
      // under-counted, so the cap cannot be defeated by a wide directory.
      size: size.truncated ? maxBytes + 1 : size.bytes,
      age: Number.isFinite(createdAt) ? now - createdAt : now - stats.mtimeMs,
    });
  }

  for (const entry of candidates) {
    if (entry.age > retentionMs) {
      try {
        await fsApi.rm(entry.directory, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        kept.push(entry.name);
      }
    } else {
      kept.push(entry.name);
    }
  }

  // The cap applies last, so retention is not shortened just because many tasks failed at
  // once. Protected entries are never part of the cap.
  let live = candidates.filter(entry => kept.includes(entry.name));
  let bytes = live.reduce((total, entry) => total + entry.size, 0);
  live.sort((left, right) => left.age < right.age ? 1 : left.age > right.age ? -1 : 0);
  while (live.length > maxEntries || bytes > maxBytes) {
    const victim = live.shift();
    if (!victim) break;
    try {
      await fsApi.rm(victim.directory, { recursive: true, force: true });
      removed.push(victim.name);
      kept.splice(kept.indexOf(victim.name), 1);
      bytes -= victim.size;
    } catch {
      break;
    }
  }

  return {
    removed, kept, protected: protectedIds, unavailable: false,
  };
}
