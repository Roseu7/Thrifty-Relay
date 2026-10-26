import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PS_ENV = { LC_ALL: "C", TZ: "UTC" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// /proc carries the real executable path. Where it is absent (macOS) the command
// field from ps is the only source, and its exactness is unverified.
const HAS_PROC = await fs.access("/proc/self/stat").then(() => true, () => false);

function platformError(code) {
  return Object.assign(new Error(code), { code });
}

export function normalizeExecutablePath(value) {
  const text = String(value ?? "");
  return text ? path.posix.normalize(text) : "";
}

// `ps` is asked for a fixed locale-independent format and reports lstart in UTC.
// The start time is the identity token that survives PID reuse, so it has to stay
// byte-identical across probes of the same process; it is also fed to Date.parse
// downstream, which is why it is normalised to ISO 8601 here.
function startedAtIso(fields) {
  const month = MONTHS.indexOf(fields[1]);
  const day = Number(fields[2]);
  const [hour, minute, second] = String(fields[3]).split(":").map(Number);
  const year = Number(fields[4]);
  if (month < 0 || ![day, hour, minute, second, year].every(Number.isSafeInteger)) return null;
  const milliseconds = Date.UTC(year, month, day, hour, minute, second);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function parseRows(stdout) {
  const rows = [];
  for (const line of String(stdout).split("\n")) {
    const fields = line.trim().split(/\s+/);
    // pid ppid weekday month day time year command...
    if (fields.length < 8) continue;
    const pid = Number(fields[0]);
    const parentPid = Number(fields[1]);
    const startedAt = startedAtIso(fields.slice(2, 7));
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parentPid) || parentPid < 0 || !startedAt) continue;
    rows.push({ pid, parent_pid: parentPid, started_at: startedAt, command: fields.slice(7).join(" ") });
  }
  return rows;
}

// Group rows need pgid and uid in addition to the fields used for a single process.
// lstart still occupies five whitespace-separated fields, so the command starts at 9.
export function parseGroupRows(stdout) {
  const rows = [];
  for (const line of String(stdout).split("\n")) {
    const fields = line.trim().split(/\s+/);
    // pid ppid pgid uid weekday month day time year command...
    if (fields.length < 10) continue;
    const pid = Number(fields[0]);
    const parentPid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const uid = Number(fields[3]);
    const startedAt = startedAtIso(fields.slice(4, 9));
    // Kernel threads report pgid 0. They are not a target group, but they are a
    // valid row; dropping them would make the table look partially parsed.
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parentPid) || parentPid < 0 ||
        !Number.isSafeInteger(pgid) || pgid < 0 || !Number.isSafeInteger(uid) || uid < 0 || !startedAt) continue;
    rows.push({ pid, parent_pid: parentPid, pgid, uid, started_at: startedAt, command: fields.slice(9).join(" ") });
  }
  return rows;
}

export async function runPs(args, { execImpl = exec, allowAbsent = false } = {}) {
  try {
    const { stdout } = await execImpl("ps", args, { env: { ...process.env, ...PS_ENV }, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (error?.killed === true || error?.signal) throw platformError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE");
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    // `ps -p` exits 1 when one or more requested PIDs are gone, and may still print
    // the rows it did find. With an empty diagnostic that is an observation, not a
    // failure. `ps -e` is different: any failure means the table is incomplete.
    if (allowAbsent && Number(error?.code) === 1 && stderr.trim() === "") return stdout;
    throw platformError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE");
  }
}

function selectDescendants(rows, roots) {
  const selected = new Set(roots);
  for (let depth = 0; depth < 256; depth++) {
    let grew = false;
    for (const row of rows) {
      if (selected.has(row.parent_pid) && !selected.has(row.pid)) { selected.add(row.pid); grew = true; }
    }
    if (!grew) break;
  }
  return rows.filter(row => selected.has(row.pid));
}

async function resolveExecutable(row) {
  if (HAS_PROC) {
    try { return await fs.readlink(`/proc/${row.pid}/exe`); } catch { return null; }
  }
  return row.command || null;
}

// lstart is second-granular. On Linux the kernel's starttime ticks distinguish a
// PID reused within the same second; macOS has no equivalent, so it stays null.
async function resolveStartToken(pid) {
  if (!HAS_PROC) return null;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    const fields = stat.slice(end + 2).split(" ");
    return fields[19] || null;
  } catch {
    return null;
  }
}

export async function probeProcesses(ids, descendants = false) {
  const roots = [...new Set(ids)];
  const fields = "pid=,ppid=,lstart=,comm=";
  const stdout = await runPs(descendants ? ["-ww", "-e", "-o", fields] : ["-ww", "-o", fields, "-p", roots.join(",")],
    { allowAbsent: !descendants });
  const parsed = parseRows(stdout);
  const lines = String(stdout).split("\n").filter(line => line.trim());
  if (lines.length !== parsed.length) throw platformError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE");
  const rows = descendants ? selectDescendants(parsed, roots)
    : parsed.filter(row => roots.includes(row.pid));
  const result = [];
  for (const row of rows) {
    result.push({ pid: row.pid, parent_pid: row.parent_pid, started_at: row.started_at,
      start_token: await resolveStartToken(row.pid), executable: await resolveExecutable(row) });
  }
  return result;
}

// Command lines are identity evidence, not persisted process records: callers that
// write probe rows must not accidentally store tokens from another program's argv.
export async function probeProcessCommand(pid, { execImpl = exec } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw platformError("REMOTE_INVALID_PROCESS_ID");
  if (HAS_PROC) {
    let uid = null;
    try {
      const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
      const match = status.match(/^Uid:\s+\d+\s+(\d+)/m);
      if (match) uid = Number(match[1]);
    } catch {}
    if (uid === null) {
      try { uid = (await fs.stat(`/proc/${pid}`)).uid; } catch { return null; }
    }
    let argv;
    try {
      const bytes = await fs.readFile(`/proc/${pid}/cmdline`);
      argv = bytes.toString("utf8").split("\0").filter(Boolean);
    } catch {
      return null;
    }
    return { pid, uid, argv, command: argv.join(" ") };
  }
  // macOS has no /proc. uid= and args= are both fixed-format ps fields; the first
  // whitespace-delimited token is the numeric UID and the rest is the command line.
  const stdout = await runPs(["-ww", "-o", "uid=,args=", "-p", String(pid)], { allowAbsent: true, execImpl });
  const text = String(stdout).trim();
  const match = text.match(/^(\d+)\s+([\s\S]*)$/);
  if (!match) return null;
  return { pid, uid: Number(match[1]), argv: null, command: match[2] };
}

export async function terminateProcessTree(pid, { probe = probeProcesses } = {}) {
  // Spawned children stay in the MCP's own process group, so signalling -pid would
  // hit the MCP itself. Killing by PID is best effort: a PID reused between the probe
  // and the signal could hit an unrelated process, which is why callers re-verify the
  // identity afterwards instead of trusting this call.
  let others = [];
  try { others = (await probe([pid], true)).filter(row => row.pid !== pid); } catch {}
  for (const row of others) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (error?.code !== "ESRCH") throw platformError("REMOTE_PROCESS_TERMINATION_FAILED"); }
}

// A detached tunnel is a process-group leader. The group is the unit that has to stop:
// waiting only for the leader would leave the MCP child behind holding the port.
export async function probeProcessGroup(pgid, { execImpl = exec, resolve = resolveExecutable } = {}) {
  if (!Number.isSafeInteger(pgid) || pgid < 1) throw platformError("REMOTE_INVALID_PROCESS_ID");
  const fields = "pid=,ppid=,pgid=,uid=,lstart=,comm=";
  const stdout = await runPs(["-ww", "-e", "-o", fields], { execImpl });
  const allRows = parseGroupRows(stdout);
  const lines = String(stdout).split("\n").filter(line => line.trim());
  if (lines.length !== allRows.length) throw platformError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE");
  const rows = allRows.filter(row => row.pgid === pgid);
  const result = [];
  for (const row of rows) {
    result.push({ pid: row.pid, parent_pid: row.parent_pid, pgid: row.pgid, uid: row.uid,
      started_at: row.started_at, start_token: await resolveStartToken(row.pid),
      executable: await resolve(row), command: row.command });
  }
  return result;
}

function groupMatches(row, expected) {
  const expectedKey = normalizeExecutablePath(expected || "");
  if (!expectedKey) return true;
  if (normalizeExecutablePath(row.executable || "") === expectedKey) return true;
  // On macOS /proc is absent, so the resolved value is the ps command field. Accept
  // the configured path when it is one of the argv words of a wrapper/script.
  return String(row.command || "").split(/\s+/).some(word =>
    normalizeExecutablePath(word.replace(/^['"]|['"]$/g, "")) === expectedKey);
}

function groupMemberKey(row) {
  return `${row.pid}:${row.start_token ?? row.started_at ?? ""}`;
}

function sameGroupMember(row, known) {
  if (!known) return false;
  if (Number.isSafeInteger(known.uid) && Number.isSafeInteger(row.uid) && known.uid !== row.uid) return false;
  return true;
}

function knownOrChild(row, initialMembers, currentByPid, euid) {
  const known = initialMembers.get(groupMemberKey(row));
  if (known) return sameGroupMember(row, known);
  if (Number.isSafeInteger(euid) && Number.isSafeInteger(row.uid) && row.uid !== euid) return false;
  // A process created after the snapshot is still ours only while its parent chain
  // reaches a member that was present in the older evidence.
  let parent = row.parent_pid;
  for (let depth = 0; depth < 64; depth++) {
    const currentParent = currentByPid.get(parent);
    if (!currentParent) return false;
    const knownParent = initialMembers.get(groupMemberKey(currentParent));
    if (knownParent) return sameGroupMember(currentParent, knownParent);
    parent = currentParent.parent_pid;
  }
  return false;
}

async function awaitGroupAbsent(pgid, { timeoutMs, probe, sleep }) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    let rows;
    try { rows = await probe(pgid); }
    catch { return { state: "unknown" }; }
    if (rows.length === 0) return { state: "absent" };
    if (Date.now() >= deadline) return { state: "present", rows };
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

function signalGroup(pgid, signal, kill) {
  try { kill(-pgid, signal); return { ok: true }; }
  catch (error) {
    if (error?.code === "ESRCH") return { ok: true, absent: true };
    if (error?.code === "EPERM") return { ok: false, code: "RUNTIME_OWNER_UNKNOWN" };
    return { ok: false, code: "RUNTIME_STOP_UNCONFIRMED" };
  }
}

// Stop by process group, not by walking descendants: a child may be reparented while
// the group stays the same. The leader's start time is checked before the signal when
// the caller recorded one, so a reused pgid is not adopted as ours.
export async function terminateProcessGroup(pgid, {
  expectedStartedAt = null,
  expectedExecutable = null,
  expectedMembers = null,
  graceMs = 10000,
  killWaitMs = 10000,
  kill = process.kill,
  probe = (target, options) => probeProcessGroup(target, options),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  execImpl,
} = {}) {
  if (!Number.isSafeInteger(pgid) || pgid < 1) throw platformError("REMOTE_INVALID_PROCESS_ID");
  if (!Number.isFinite(graceMs) || graceMs < 0 || !Number.isFinite(killWaitMs) || killWaitMs < 0 ||
      (expectedMembers !== null && !Array.isArray(expectedMembers))) {
    throw platformError("REMOTE_INVALID_PROCESS_ID");
  }
  const read = () => probe(pgid, execImpl ? { execImpl } : undefined);
  let rows;
  try { rows = await read(); }
  catch { return { ok: false, code: "RUNTIME_OWNER_UNKNOWN" }; }
  if (rows.length === 0) {
    // ps and kill see the process table through different interfaces. Absence is
    // only confirmed when both agree; a hidden group is owner-unknown, not stopped.
    const presence = signalGroup(pgid, 0, kill);
    if (!presence.ok) return presence;
    return presence.absent ? { ok: true } : { ok: false, code: "RUNTIME_OWNER_UNKNOWN" };
  }

  const euid = process.geteuid?.();
  const priorMembers = new Map((expectedMembers || []).map(row => [groupMemberKey(row), row]));
  const leader = rows.find(row => row.pid === pgid);
  if (!leader) {
    // A first observation made during stop cannot prove that an existing pgid is
    // ours. Only a snapshot captured while the caller still owned the group can.
    if (!priorMembers.size) return { ok: false, code: "RUNTIME_OWNER_UNVERIFIED" };
    const currentByPid = new Map(rows.map(row => [row.pid, row]));
    if (rows.some(row => !knownOrChild(row, priorMembers, currentByPid, euid))) {
      return { ok: false, code: "RUNTIME_OWNER_MISMATCH" };
    }
  }
  const initialMembers = new Map([...priorMembers, ...rows.map(row => [groupMemberKey(row), row])]);
  const foreignUid = rows.find(row =>
    Number.isSafeInteger(row.uid) && Number.isSafeInteger(euid) && row.uid !== euid);
  if (foreignUid) return { ok: false, code: "RUNTIME_OWNER_MISMATCH" };
  if (leader && expectedStartedAt && leader.started_at !== expectedStartedAt) {
    return { ok: false, code: "RUNTIME_OWNER_MISMATCH" };
  }
  if (leader && expectedExecutable && !groupMatches(leader, expectedExecutable)) {
    return { ok: false, code: "RUNTIME_OWNER_MISMATCH" };
  }

  const term = signalGroup(pgid, "SIGTERM", kill);
  if (!term.ok) return term;
  if (term.absent) return { ok: true };
  let state = await awaitGroupAbsent(pgid, { timeoutMs: graceMs, probe: read, sleep });
  if (state.state === "unknown") return { ok: false, code: "RUNTIME_OWNER_UNKNOWN" };
  if (state.state === "absent") {
    const presence = signalGroup(pgid, 0, kill);
    if (!presence.ok) return presence;
    return presence.absent ? { ok: true } : { ok: false, code: "RUNTIME_STOP_UNCONFIRMED" };
  }

  // Never SIGKILL a group that has gained an unrelated member since the first
  // probe. A new child of a known member is accepted; a reused pgid is not.
  const currentRows = state.rows || [];
  const currentByPid = new Map(currentRows.map(row => [row.pid, row]));
  const foreign = currentRows.filter(row =>
    !knownOrChild(row, initialMembers, currentByPid, euid));
  if (foreign.length) return { ok: false, code: "RUNTIME_OWNER_MISMATCH" };

  const forced = signalGroup(pgid, "SIGKILL", kill);
  if (!forced.ok) return forced;
  if (forced.absent) return { ok: true };
  state = await awaitGroupAbsent(pgid, { timeoutMs: killWaitMs, probe: read, sleep });
  if (state.state === "unknown") return { ok: false, code: "RUNTIME_OWNER_UNKNOWN" };
  return state.state === "absent" ? { ok: true } : { ok: false, code: "RUNTIME_STOP_UNCONFIRMED" };
}
