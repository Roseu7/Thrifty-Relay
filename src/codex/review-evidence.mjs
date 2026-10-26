import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Metadata/hashes only; file bodies and Git diffs are fetched through existing read/run.
export async function snapshotFiles(cwd) {
  const files = Object.create(null), issues = [], excluded = [];
  let total = 0, count = 0;
  const issue = value => { if (issues.length < 20) issues.push(value); };
  async function visit(directory, relative = "", depth = 0) {
    if (depth > 20) { issue("depth_limit"); return; }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { issue("directory_unreadable:" + relative); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory() && [".git", "node_modules"].includes(entry.name)) { if (excluded.length < 20) excluded.push(name); continue; }
      if (++count > 2000) { issue("entry_limit"); return; }
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { issue("link_not_followed:" + name); continue; }
      if (entry.isDirectory()) { await visit(file, name, depth + 1); continue; }
      if (!entry.isFile()) { issue("special_file:" + name); continue; }
      let handle;
      try {
        handle = await fs.open(file, "r");
        const before = await handle.stat();
        if (before.size > 4 * 1024 * 1024 || total + before.size > 32 * 1024 * 1024) { issue("byte_limit:" + name); continue; }
        const buffer = Buffer.alloc(before.size + 1);
        let offset = 0, read;
        do { read = (await handle.read(buffer, offset, buffer.length - offset, offset)).bytesRead; offset += read; }
        while (read && offset < buffer.length);
        const data = buffer.subarray(0, offset); total += data.length;
        const after = await handle.stat();
        if (data.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) { issue("changed_during_scan:" + name); continue; }
        files[name] = { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
      } catch { issue("file_unreadable:" + name); }
      finally { await handle?.close(); }
    }
  }
  await visit(cwd);
  return { files, complete: issues.length === 0, issues, excluded, bytes_hashed: total };
}

export function compareFiles(before, after, expected) {
  const planned = expected ? new Set(expected) : null;
  const changes = [];
  for (const name of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const a = before.files[name], b = after.files[name];
    if (a?.sha256 === b?.sha256) continue;
    changes.push({ path: name, change: !a ? "added" : !b ? "deleted" : "modified",
      before: a?.sha256 || null, after: b?.sha256 || null, planned: planned ? planned.has(name) : null });
  }
  return { complete: before.complete && after.complete, changes,
    unexpected: planned ? changes.filter(item => !item.planned).map(item => item.path) : null,
    issues: [...before.issues, ...after.issues], excluded: [...new Set([...before.excluded, ...after.excluded])] };
}

export function reviewSummary(report) {
  return { complete: report.files.complete, changed_count: report.files.changes.length,
    changed: report.files.changes.slice(0, 8).map(item => item.path.slice(0, 160)),
    unexpected_count: report.files.unexpected?.length ?? null,
    unexpected: report.files.unexpected?.slice(0, 5).map(name => name.slice(0, 160)) ?? null,
    command_count: report.commands?.length || 0, commands_omitted: report.commands_omitted || 0,
    command_evidence_complete: report.command_evidence_complete === true,
    limitation: "cwd hashes only; .git/node_modules excluded; command results need GPT review; not a sandbox or completion verdict" };
}
