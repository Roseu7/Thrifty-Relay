import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

// Apply a batch only after every edit has been checked against the current files.
// This intentionally handles existing UTF-8 text files, not binary files or deletes.
export async function applyPatch(files) {
  const staged = [];
  const paths = new Set();
  let editCount = 0;

  for (const entry of files) {
    const file = path.resolve(entry.path);
    if (!path.isAbsolute(entry.path)) throw new Error("Patch requires an absolute file path: " + entry.path);
    const key = file.toLowerCase();
    if (paths.has(key)) throw new Error("Duplicate file in patch: " + file);
    paths.add(key);

    const originalBytes = await fs.readFile(file);
    const original = originalBytes.toString("utf8");
    if (!Buffer.from(original, "utf8").equals(originalBytes)) {
      throw new Error("Patch refuses a non-UTF-8 file: " + file);
    }
    if (entry.sha256) {
      const actual = createHash("sha256").update(originalBytes).digest("hex");
      if (actual !== entry.sha256.toLowerCase()) throw new Error("Patch SHA-256 mismatch: " + file);
    }

    let updated = original;
    for (const edit of entry.edits) {
      const oldText = edit.old_string;
      if (!oldText) throw new Error("Patch old_string cannot be empty: " + file);
      const matches = updated.split(oldText).length - 1;
      const expected = edit.expected_replacements ?? 1;
      if (matches !== expected) {
        throw new Error("Patch match count " + matches + " (expected " + expected + "): " + file);
      }
      updated = updated.split(oldText).join(edit.new_string);
      editCount++;
    }
    staged.push({
      file, originalBytes, updatedBytes: Buffer.from(updated, "utf8"),
      temp: file + ".thriftyrelay-" + process.pid + "-" + randomBytes(5).toString("hex") + ".tmp",
    });
  }

  const committed = [];
  const rollbackErrors = [];
  try {
    // Prepare all new versions before touching any original.
    for (const item of staged) await fs.writeFile(item.temp, item.updatedBytes, { flag: "wx" });
    for (const item of staged) {
      // Refuse to overwrite concurrent edits.
      const current = await fs.readFile(item.file);
      if (!current.equals(item.originalBytes)) throw new Error("Patch file changed while staging: " + item.file);
      await fs.rename(item.temp, item.file);
      committed.push(item);
    }
  } catch (error) {
    for (const item of committed.reverse()) {
      try {
        await fs.writeFile(item.file, item.originalBytes);
      } catch (rollbackError) {
        rollbackErrors.push(item.file + ": " + String(rollbackError));
      }
    }
    throw new Error(
      "Patch failed: " + String(error) +
      (rollbackErrors.length ? "; ROLLBACK INCOMPLETE: " + rollbackErrors.join("; ") : "; committed files restored")
    );
  } finally {
    for (const item of staged) await fs.unlink(item.temp).catch(() => {});
  }

  return "patch: OK (" + staged.length + " files, " + editCount + " edits)";
}
