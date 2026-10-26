import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Flush before dispatch; filesystem flush is not a guarantee against disk loss.
// Retry metadata replacement only, never the task that may have written files.
export async function writeRecord(file, record, exclusive = false) {
  const target = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(target, "wx", 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    // Publish a complete durable claim atomically; a losing creator cannot
    // overwrite it. Unsupported hard-link filesystems fail closed.
    if (exclusive) { await fs.link(target, file); return; }
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(target, file); break; }
      catch (error) {
        if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  } finally { await fs.unlink(target).catch(() => {}); }
}
