import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";

export const LOG_FILE_NAME = "runtime.log";
export const LOG_ROTATED_NAME = "runtime.log.1";
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_CLOEXEC = fs.constants.O_CLOEXEC ?? 0;

function logError(code, cause) {
  return Object.assign(new Error(code), { code, cause });
}

async function openTarget(file) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW | O_CLOEXEC;
  let handle;
  try { handle = await fs.open(file, flags, 0o600); }
  catch (error) { throw logError("RUNTIME_LOG_UNAVAILABLE", error); }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o7777) !== 0o600) {
      throw logError("RUNTIME_LOG_UNAVAILABLE");
    }
    return { handle, bytes: stats.size };
  } catch (error) {
    await handle.close().catch(() => {});
    if (error?.code) throw error;
    throw logError("RUNTIME_LOG_UNAVAILABLE", error);
  }
}

async function rotate(directory, file, rotated) {
  const previous = await fs.lstat(rotated).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw logError("RUNTIME_LOG_UNAVAILABLE", error);
  });
  if (previous) {
    if (!previous.isFile() || previous.nlink !== 1 || (previous.mode & 0o7777) !== 0o600) {
      throw logError("RUNTIME_LOG_UNAVAILABLE");
    }
  }
  await fs.rename(file, rotated).catch(error => { throw logError("RUNTIME_LOG_UNAVAILABLE", error); });
  await fsyncDirectory(directory);
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    await handle.sync().catch(() => {});
  } catch {}
  finally { await handle?.close().catch(() => {}); }
}

// The supervisor's log is opened before the tunnel starts. A write failure after
// that point degrades to discard instead of stopping the runtime (§11).
export async function createRuntimeLog(file, {
  maxBytes = MAX_LOG_BYTES,
  assertTrustedDirectory,
  uid = process.geteuid?.(),
} = {}) {
  if (typeof assertTrustedDirectory !== "function") throw logError("RUNTIME_LOG_UNAVAILABLE");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw logError("RUNTIME_LOG_UNAVAILABLE");
  if (!path.posix.isAbsolute(file)) throw logError("RUNTIME_LOG_UNAVAILABLE");
  const directory = path.posix.dirname(file);
  await assertTrustedDirectory(directory, { uid });
  const target = path.posix.join(directory, path.posix.basename(file));
  const rotated = path.posix.join(directory, LOG_ROTATED_NAME);

  let current = await openTarget(target);
  if (current.bytes >= maxBytes) {
    await current.handle.close().catch(() => {});
    await rotate(directory, target, rotated);
    current = await openTarget(target);
  }

  let handle = current.handle;
  let bytes = current.bytes;
  let degraded = false;
  let closed = false;

  const reopen = async () => {
    await handle.close().catch(() => {});
    await rotate(directory, target, rotated);
    current = await openTarget(target);
    handle = current.handle;
    bytes = current.bytes;
  };

  const stream = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk, _encoding, callback) {
      if (closed || degraded) { callback(); return; }
      void (async () => {
        try {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (bytes + data.length > maxBytes) await reopen();
          await handle.write(data);
          bytes += data.length;
        } catch {
          degraded = true;
        }
        callback();
      })();
    },
  });

  return {
    stream,
    get degraded() { return degraded; },
    async end() {
      if (closed) return;
      await new Promise(resolve => stream.end(resolve));
      closed = true;
      if (!degraded) await handle.sync().catch(() => {});
      await handle.close().catch(() => {});
    },
  };
}
