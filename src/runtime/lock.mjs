import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const LOCK_DIRECTORY = "runtime.lock";
export const RECLAIM_DIRECTORY = "runtime.lock.reclaim";
const STALE_LOCK_MS = 120_000;

function lockError(code) {
  return Object.assign(new Error(code), { code });
}

async function statOrNull(target) {
  try { return await fs.stat(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw lockError("RUNTIME_STATE_UNAVAILABLE");
  }
}

async function remove(target) {
  await fs.rm(target, { recursive: true, force: true });
}

// mkdir is the atomic primitive available in every supported Node version. A
// stale lock is reclaimed only by the holder of runtime.lock.reclaim, and the
// lock is re-read after that second mkdir so two reclaimers cannot both win.
export async function acquireRuntimeLock(directory, {
  staleMs = STALE_LOCK_MS,
  now = Date.now(),
} = {}) {
  if (!Number.isFinite(staleMs) || staleMs < 0) throw lockError("RUNTIME_STATE_UNAVAILABLE");
  const lock = path.join(directory, LOCK_DIRECTORY);
  const reclaim = path.join(directory, RECLAIM_DIRECTORY);

  const createLock = async () => {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      // A released lock can be replaced immediately by another starter. Remember
      // a random token so a second release never removes the replacement lock.
      const token = randomUUID();
      await fs.writeFile(path.join(lock, "owner"), token, { mode: 0o600, flag: "wx" });
      return {
        path: lock,
        async release() {
          const current = await fs.readFile(path.join(lock, "owner"), "utf8")
            .catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
          if (current !== token) return;
          await remove(lock);
        },
      };
    } catch (error) {
      if (error?.code === "EEXIST") return null;
      await remove(lock).catch(() => {});
      throw lockError("RUNTIME_STATE_UNAVAILABLE");
    }
  };

  const acquired = await createLock();
  if (acquired) return acquired;

  const before = await statOrNull(lock);
  if (!before || now - before.mtimeMs < staleMs) throw lockError("RUNTIME_BUSY");

  try {
    await fs.mkdir(reclaim, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw lockError("RUNTIME_STATE_UNAVAILABLE");
    // A reclaimer that died after creating this directory must not make the
    // runtime permanently busy. The window is protected by the same age check.
    const staleReclaim = await statOrNull(reclaim);
    if (!staleReclaim || now - staleReclaim.mtimeMs < staleMs) throw lockError("RUNTIME_BUSY");
    await remove(reclaim);
    return acquireRuntimeLock(directory, { staleMs, now });
  }

  try {
    const current = await statOrNull(lock);
    if (!current || current.mtimeMs !== before.mtimeMs || now - current.mtimeMs < staleMs) {
      throw lockError("RUNTIME_BUSY");
    }
    await remove(lock);
    const replacement = await createLock();
    if (!replacement) throw lockError("RUNTIME_BUSY");
    return replacement;
  } finally {
    await remove(reclaim);
  }
}
