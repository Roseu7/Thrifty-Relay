import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { writeRecord } from "../src/mcp/task-storage.mjs";

function fail(code) { throw Object.assign(new Error(code), { code }); }
const markerName = ".thriftyrelay-tests.json";
function inside(root, file) { const relative = path.relative(root, file); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); }
function positive(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) fail("TEST_INVALID_RETENTION_SETTING");
  return number;
}

async function inventory(directory) {
  let bytes = 0, count = 0;
  const protectedReasons = new Set();
  async function visit(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (++count > 100000) fail("TEST_SCAN_LIMIT_NO_DELETE");
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { protectedReasons.add("link_present"); continue; }
      if (entry.isDirectory()) {
        if (path.basename(dir) === "codex" && ["requests", "recovery"].includes(entry.name)) protectedReasons.add("durable_codex_records");
        await visit(file); continue;
      }
      let info;
      try { info = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      bytes += info.size;
      if (["active.lock", "maintenance.lock"].includes(entry.name)) protectedReasons.add("execution_lock");
      if (/^cx_[a-f0-9]+\.json$/.test(entry.name)) protectedReasons.add("conversation_record");
      if (/^task_.*\.json$/.test(entry.name)) {
        if (info.size > 1024 * 1024) { protectedReasons.add("task_record_too_large"); continue; }
        try {
          const task = JSON.parse(await fs.readFile(file, "utf8"));
          if (!task.finished_at || task.guard_state === "unknown" || (task.execution_unknown && !task.recovery)) protectedReasons.add("unfinished_or_unknown_task");
        } catch { protectedReasons.add("unreadable_task_record"); }
      }
    }
  }
  await visit(directory);
  return { bytes, protected_reasons: [...protectedReasons] };
}

export async function testArea(rootInput = process.env.THRIFTYRELAY_TEST_ROOT || path.resolve(import.meta.dirname, "..", ".test-artifacts")) {
  if (!path.isAbsolute(rootInput)) fail("TEST_ABSOLUTE_ROOT_REQUIRED");
  const resolved = path.resolve(rootInput);
  if ([path.parse(resolved).root.toLowerCase(), os.homedir().toLowerCase()].includes(resolved.toLowerCase())) fail("TEST_UNSAFE_ROOT");
  await fs.mkdir(resolved, { recursive: true });
  const root = await fs.realpath(resolved);
  if (root.toLowerCase() !== resolved.toLowerCase() || (await fs.lstat(resolved)).isSymbolicLink()) fail("TEST_LINK_ROOT_FORBIDDEN");
  const marker = path.join(root, markerName);
  let owner;
  try { owner = JSON.parse(await fs.readFile(marker, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") fail("TEST_ROOT_MARKER_INVALID");
    if ((await fs.readdir(root)).length) fail("TEST_ROOT_NOT_OWNED");
    owner = { version: 1, product: "ThriftyRelay", id: randomUUID() };
    await writeRecord(marker, owner, true);
  }
  if (owner.version !== 1 || owner.product !== "ThriftyRelay" || !/^[a-f0-9-]{36}$/.test(owner.id || "")) fail("TEST_ROOT_MARKER_INVALID");
  const runs = path.join(root, "runs"); await fs.mkdir(runs, { recursive: true });
  if ((await fs.lstat(runs)).isSymbolicLink()) fail("TEST_LINK_RUNS_FORBIDDEN");
  const maxBytes = positive(process.env.THRIFTY_TEST_MAX_BYTES, 256 * 1024 * 1024);
  const maxAge = positive(process.env.THRIFTY_TEST_MAX_AGE_HOURS, 168) * 3600000;

  async function removePayload(runDir, record) {
    if (record.owner !== owner.id || record.state !== "passed" || record.processes_stopped !== true) return { removed: false, reasons: ["not_confirmed_passed"] };
    const payload = path.join(runDir, "payload");
    try { await fs.lstat(payload); } catch (error) { if (error.code === "ENOENT") return { removed: false, reasons: [] }; throw error; }
    if (!inside(runs, runDir) || path.dirname(runDir).toLowerCase() !== runs.toLowerCase() || !/^run-[a-f0-9-]{36}$/.test(path.basename(runDir))) fail("TEST_DELETE_PATH_INVALID");
    if ((await fs.lstat(runDir)).isSymbolicLink() || (await fs.lstat(payload)).isSymbolicLink()) fail("TEST_DELETE_LINK_FORBIDDEN");
    const actual = await fs.realpath(payload);
    if (actual.toLowerCase() !== payload.toLowerCase() || !inside(root, actual)) fail("TEST_DELETE_PATH_ESCAPED");
    const info = await inventory(payload);
    if (info.protected_reasons.length) return { removed: false, reasons: info.protected_reasons };
    // Exact canonical owned payload, no links, terminal suite and stopped process evidence.
    // Windows holds a handle on a file for a moment after the process holding it exits, so
    // the delete retries. A lock that outlasts the retries is not evidence about the run:
    // the next suite's sweep tries again and the area still counts against the capacity
    // limit, so it is recorded instead of turning a green run red.
    try {
      await fs.rm(actual, { recursive: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      if (["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"].includes(error.code)) return { removed: false, reasons: ["cleanup_busy"] };
      throw error;
    }
    return { removed: true, reasons: [] };
  }
  async function sweep() {
    const outcomes = [];
    for (const entry of await fs.readdir(runs, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^run-[a-f0-9-]{36}$/.test(entry.name)) continue;
      const runDir = path.join(runs, entry.name);
      let record;
      try { record = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8")); } catch { continue; }
      if (Date.now() - Date.parse(record.finished_at || record.started_at) < maxAge) continue;
      const result = await removePayload(runDir, record);
      if (result.removed) { record.cleanup = result; await writeRecord(path.join(runDir, "run.json"), record); }
      outcomes.push({ run: entry.name, ...result });
    }
    return outcomes;
  }
  async function begin(suite) {
    await sweep();
    const used = await inventory(root);
    if (used.protected_reasons.includes("link_present")) fail("TEST_ROOT_LINK_PRESENT");
    if (used.bytes >= maxBytes) fail("TEST_CAPACITY_EXCEEDED_PROTECTED_EVIDENCE_RETAINED");
    const id = "run-" + randomUUID(), runDir = path.join(runs, id), payload = path.join(runDir, "payload");
    await fs.mkdir(payload, { recursive: true });
    const record = { version: 1, owner: owner.id, id, suite, state: "running", runner_pid: process.pid, started_at: new Date().toISOString() };
    await writeRecord(path.join(runDir, "run.json"), record);
    return { root: payload, runDir, async finish({ success, processes_stopped, evidence = "" }) {
      record.state = success ? "passed" : "failed"; record.processes_stopped = processes_stopped === true;
      record.finished_at = new Date().toISOString();
      await fs.writeFile(path.join(runDir, "evidence.log"), evidence.slice(-16384));
      await writeRecord(path.join(runDir, "run.json"), record);
      record.cleanup = await removePayload(runDir, record);
      const current = await inventory(root);
      record.area_bytes = current.bytes; record.capacity_exceeded = current.bytes > maxBytes;
      await writeRecord(path.join(runDir, "run.json"), record);
      return { run: id, state: record.state, cleanup: record.cleanup, area_bytes: current.bytes, capacity_exceeded: record.capacity_exceeded };
    } };
  }
  return { root, begin, sweep };
}
