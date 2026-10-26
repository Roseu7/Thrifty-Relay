import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathsAdapter } from "../platform/index.mjs";

export const STATE_FILE_NAME = "runtime.json";
export const STATE_VERSION = 1;
export const MAX_STATE_BYTES = 64 * 1024;

const STATES = new Set(["starting", "running", "stopping", "stopped", "failed"]);
const MODES = new Set(["background", "foreground"]);
const CLEANUP = new Set(["complete", "unconfirmed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const O_CLOEXEC = fs.constants.O_CLOEXEC ?? 0;

function stateError(code, cause) {
  return Object.assign(new Error(code), { code, cause });
}

function effectiveUid(uid) {
  const value = uid ?? process.geteuid?.();
  if (!Number.isSafeInteger(value) || value < 0) throw stateError("RUNTIME_STATE_UNAVAILABLE");
  return value;
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function invalid() {
  throw stateError("RUNTIME_STATE_INVALID");
}

function present(value, key) {
  return Object.hasOwn(value, key);
}

function nullable(value, predicate) {
  return value === null || predicate(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function absolutePath(value) {
  return typeof value === "string" && value.length > 0 && path.posix.isAbsolute(value);
}

// The schema is deliberately strict: a state file is management input, not a hint.
// Unknown fields are dropped so a future caller cannot smuggle data through this path.
export function validateRuntimeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  for (const key of ["version", "instanceId", "state", "mode", "port", "healthUrl", "logFile",
    "createdAt", "supervisorPid", "supervisorUid", "supervisorStartedAt", "supervisorExecutable",
    "supervisorCommand", "tunnelPid", "tunnelUid", "tunnelStartedAt", "tunnelExecutable",
    "tunnelCommand", "tunnelPgid", "ownerVerified", "cleanup", "errorCode"]) {
    if (!present(value, key)) invalid();
  }
  if (value.version !== STATE_VERSION || !UUID.test(value.instanceId) ||
      !STATES.has(value.state) || !MODES.has(value.mode) ||
      !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
      value.healthUrl !== `http://127.0.0.1:${value.port}` ||
      !absolutePath(value.logFile) || !isTimestamp(value.createdAt) ||
      !nullable(value.supervisorPid, positiveInteger) || !nullable(value.supervisorUid, uid => Number.isSafeInteger(uid) && uid >= 0) ||
      !nullable(value.supervisorStartedAt, isTimestamp) || !nullable(value.supervisorExecutable, absolutePath) ||
      !nullable(value.supervisorCommand, command => typeof command === "string") ||
      !nullable(value.tunnelPid, positiveInteger) || !nullable(value.tunnelUid, uid => Number.isSafeInteger(uid) && uid >= 0) ||
      !nullable(value.tunnelStartedAt, isTimestamp) || !nullable(value.tunnelExecutable, absolutePath) ||
      !nullable(value.tunnelCommand, command => typeof command === "string") ||
      !nullable(value.tunnelPgid, positiveInteger) || typeof value.ownerVerified !== "boolean" ||
      !nullable(value.cleanup, cleanup => CLEANUP.has(cleanup)) ||
      !nullable(value.errorCode, code => typeof code === "string" && ERROR_CODE.test(code))) invalid();
  if (value.state === "running" && (value.ownerVerified !== true || !positiveInteger(value.tunnelPid) ||
      !isTimestamp(value.tunnelStartedAt) || !absolutePath(value.tunnelExecutable) ||
      !positiveInteger(value.tunnelPgid))) invalid();
  return {
    version: STATE_VERSION,
    instanceId: value.instanceId,
    state: value.state,
    mode: value.mode,
    port: value.port,
    healthUrl: value.healthUrl,
    logFile: value.logFile,
    createdAt: value.createdAt,
    supervisorPid: value.supervisorPid,
    supervisorUid: value.supervisorUid,
    supervisorStartedAt: value.supervisorStartedAt,
    supervisorExecutable: value.supervisorExecutable,
    supervisorCommand: value.supervisorCommand,
    tunnelPid: value.tunnelPid,
    tunnelUid: value.tunnelUid,
    tunnelStartedAt: value.tunnelStartedAt,
    tunnelExecutable: value.tunnelExecutable,
    tunnelCommand: value.tunnelCommand,
    tunnelPgid: value.tunnelPgid,
    ownerVerified: value.ownerVerified,
    cleanup: value.cleanup,
    errorCode: value.errorCode,
  };
}

export function runtimeDirectory({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = pathsAdapter(platform);
  if (typeof paths.runtimeDirectory !== "function") throw stateError("REMOTE_PLATFORM_UNSUPPORTED");
  if (typeof home !== "string" || !paths.isAbsolute(home)) throw stateError("RUNTIME_STATE_UNAVAILABLE");
  const directory = paths.runtimeDirectory({ env, home });
  if (!paths.isAbsolute(directory)) throw stateError("RUNTIME_STATE_UNAVAILABLE");
  return paths.normalize(directory);
}

export function runtimeStateFile(options = {}) {
  return path.posix.join(runtimeDirectory(options), STATE_FILE_NAME);
}

function checkFileStats(stats, uid, maxBytes = MAX_STATE_BYTES) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== uid ||
      (stats.mode & 0o7777) !== 0o600 || stats.nlink !== 1 || stats.size > maxBytes) {
    throw stateError("RUNTIME_STATE_INSECURE");
  }
}

async function checkPathPrefixes(value, owner, { allowSymlinks }) {
  let current = "/";
  for (const part of value.split("/")) {
    if (!part) continue;
    current = path.posix.join(current, part);
    let stats;
    try { stats = await fs.lstat(current); }
    catch { throw stateError("RUNTIME_STATE_UNAVAILABLE"); }
    if (stats.isSymbolicLink()) {
      // A symlink's own mode is fixed at 0777, so ownership plus the already checked
      // parent directory is the condition that keeps another UID from retargeting it.
      if (!allowSymlinks) throw stateError("RUNTIME_STATE_INSECURE");
      if (stats.uid !== 0 && stats.uid !== owner) throw stateError("RUNTIME_STATE_INSECURE");
      continue;
    }
    if (!stats.isDirectory() || (stats.uid !== 0 && stats.uid !== owner) ||
        (stats.mode & 0o022) !== 0) {
      throw stateError("RUNTIME_STATE_INSECURE");
    }
  }
}

// Check the written path first (so a symlinked ancestor's parent is trusted), then
// resolve and check the canonical path. A component swapped after either pass is
// caught again by the O_NOFOLLOW open of the leaf.
export async function assertTrustedDirectory(directory, { uid } = {}) {
  const owner = effectiveUid(uid);
  // `..` after a symlink is resolved by the kernel differently from a lexical
  // normalisation. State paths are generated by us, so reject the ambiguous form.
  if (!path.posix.isAbsolute(directory) || directory.includes("\0") ||
      directory.split("/").includes("..")) throw stateError("RUNTIME_STATE_INSECURE");
  const input = path.posix.resolve(directory);
  await checkPathPrefixes(input, owner, { allowSymlinks: true });
  let resolved;
  try { resolved = await fs.realpath(input); }
  catch { throw stateError("RUNTIME_STATE_UNAVAILABLE"); }
  if (!path.posix.isAbsolute(resolved)) throw stateError("RUNTIME_STATE_INSECURE");
  await checkPathPrefixes(resolved, owner, { allowSymlinks: false });
  return resolved;
}

// mkdir(recursive) may create the directory with the caller's umask; fchmod on the
// opened fd is what makes the final mode independent of the path being swapped.
export async function ensureRuntimeDirectory(directory, { uid } = {}) {
  const owner = effectiveUid(uid);
  try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch { throw stateError("RUNTIME_STATE_UNAVAILABLE"); }
  const resolved = await assertTrustedDirectory(directory, { uid: owner });
  let handle;
  try { handle = await fs.open(resolved, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); }
  catch (error) {
    if (error?.code === "ELOOP") throw stateError("RUNTIME_STATE_INSECURE");
    throw stateError("RUNTIME_STATE_UNAVAILABLE");
  }
  try {
    await handle.chmod(0o700);
    const stats = await handle.stat();
    if (!stats.isDirectory() || stats.uid !== owner || (stats.mode & 0o7777) !== 0o700) {
      throw stateError("RUNTIME_STATE_INSECURE");
    }
  } catch (error) {
    if (error?.code?.startsWith("RUNTIME_")) throw error;
    throw stateError("RUNTIME_STATE_INSECURE");
  } finally {
    await handle.close().catch(() => {});
  }
  return resolved;
}

async function readTrustedFile(file, { uid, maxBytes = MAX_STATE_BYTES } = {}) {
  const owner = effectiveUid(uid);
  if (!path.posix.isAbsolute(file) || file.includes("\0") || file.split("/").includes("..")) {
    throw stateError("RUNTIME_STATE_INSECURE");
  }
  // Read through the verified canonical directory, not through the possibly
  // symlinked path that was inspected before the kernel resolved it.
  const directory = await assertTrustedDirectory(path.posix.dirname(file), { uid: owner });
  const target = path.posix.join(directory, path.posix.basename(file));
  let before;
  try { before = await fs.lstat(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw stateError("RUNTIME_STATE_UNAVAILABLE");
  }
  if (!before.isFile() || before.isSymbolicLink()) throw stateError("RUNTIME_STATE_INSECURE");
  checkFileStats(before, owner, maxBytes);
  let handle;
  try { handle = await fs.open(target, fs.constants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") throw stateError("RUNTIME_STATE_INSECURE");
    throw stateError("RUNTIME_STATE_UNAVAILABLE");
  }
  try {
    const stats = await handle.stat();
    checkFileStats(stats, owner, maxBytes);
    if (stats.dev !== before.dev || stats.ino !== before.ino) throw stateError("RUNTIME_STATE_INSECURE");
    const text = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw stateError("RUNTIME_STATE_INSECURE");
    return text;
  } catch (error) {
    if (error?.code?.startsWith("RUNTIME_")) throw error;
    throw stateError("RUNTIME_STATE_UNAVAILABLE");
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseState(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw stateError("RUNTIME_STATE_INVALID"); }
  return validateRuntimeState(value);
}

export async function readRuntimeState(file, { uid } = {}) {
  const text = await readTrustedFile(file, { uid });
  return text === null ? null : parseState(text);
}

// Write to a sibling with O_EXCL, fsync it, then rename. The rename replaces a
// symlink itself rather than its target and leaves either the old or the new file.
export async function writeRuntimeState(file, value, { uid } = {}) {
  const state = validateRuntimeState(value);
  const owner = effectiveUid(uid);
  if (!path.posix.isAbsolute(file) || file.includes("\0") || file.split("/").includes("..")) {
    throw stateError("RUNTIME_STATE_INSECURE");
  }
  const directory = await ensureRuntimeDirectory(path.posix.dirname(file), { uid: owner });
  const target = path.posix.join(directory, path.posix.basename(file));
  const temp = path.posix.join(directory, `.${path.posix.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      O_NOFOLLOW | O_CLOEXEC, 0o600);
    const text = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw stateError("RUNTIME_STATE_INSECURE");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    checkFileStats(await handle.stat(), owner);
    await handle.close();
    handle = null;
    await fs.rename(temp, target);
    await fsyncDirectory(directory);
    return state;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    if (error?.code?.startsWith("RUNTIME_")) throw error;
    throw stateError("RUNTIME_STATE_UNAVAILABLE");
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); }
  catch { return; }
  try { await handle.sync(); } catch {}
  finally { await handle.close().catch(() => {}); }
}
