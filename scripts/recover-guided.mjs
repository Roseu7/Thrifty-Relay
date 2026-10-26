import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathsAdapter } from "../src/platform/index.mjs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { inspectRecovery, inspectScopedRecovery, recoverExecution, recoverScopedLease } from "../src/mcp/recovery.mjs";
import { formatLanguageError, parseLanguageFlags, resolveLanguagePreference, translate } from "../src/i18n/index.mjs";

function write(output, text) {
  output.write(text + "\n");
}

function failure(code, language = "en") {
  const guidance = {
    REMOTE_LOCAL_INTERACTIVE_CONSOLE_REQUIRED: "recovery.failure.interactive",
    REMOTE_GUIDED_ARGUMENTS_INVALID: "recovery.failure.arguments",
    REMOTE_GUIDED_TASK_DIR_UNAVAILABLE: "recovery.failure.directory",
    REMOTE_GUIDED_INPUT_CANCELLED: "recovery.failure.cancelled",
    REMOTE_OWNER_TASK_STILL_ACTIVE: "recovery.failure.ownerActive",
    REMOTE_SCOPED_LEASE_OWNER_ACTIVE: "recovery.failure.ownerActive",
    REMOTE_OWNED_PROCESS_STILL_ALIVE: "recovery.failure.processAlive",
    REMOTE_LOCK_CHANGED: "recovery.failure.lockChanged",
    REMOTE_HUMAN_APPROVAL_REQUIRED: "recovery.failure.approvalRequired",
    REMOTE_MAINTENANCE_LOCKED_INSPECT_REQUIRED: "recovery.failure.maintenanceLocked",
    REMOTE_APPROVAL_MUST_NOT_CONTAIN_SECRETS: "recovery.failure.secrets",
    REMOTE_GUIDED_POST_CHECK_FAILED: "recovery.failure.postCheck",
    REMOTE_SCOPED_OTHER_LEASES_ACTIVE: "recovery.failure.otherLeases",
    REMOTE_SCOPED_UNKNOWN_LEASE_NOT_FOUND: "recovery.failure.noUnknownLease",
    REMOTE_SCOPED_SELECTION_MISMATCH: "recovery.failure.selectionMismatch",
    REMOTE_SCOPED_RECORD_MISMATCH: "recovery.failure.scopedRecordMismatch",
    REMOTE_RECOVERY_RECORD_UNAVAILABLE: "recovery.failure.scopedRecordMismatch",
    REMOTE_RECOVERY_RECORD_CHANGED: "recovery.failure.lockChanged",
    REMOTE_PROCESS_EVIDENCE_CHANGED: "recovery.failure.processChanged",
    REMOTE_RECOVERY_AUDIT_UNAVAILABLE: "recovery.failure.auditUnavailable",
    REMOTE_RECOVERY_AUDIT_UPDATE_FAILED: "recovery.failure.auditUpdateFailed",
    REMOTE_RECOVERY_POST_RELEASE_RECORD_FAILED: "recovery.failure.postReleaseRecordFailed",
  };
  const key = guidance[code] || (code?.startsWith("REMOTE_") ? "recovery.failure.remoteUnknown" : "recovery.failure.generic");
  const explanation = translate(language, key, { usage: translate(language, "cli.usage.recover") });
  return translate(language, "recovery.failure.stopped", { code: code || "REMOTE_GUIDED_RECOVERY_FAILED", explanation });
}

function errorCode(error) {
  if (error?.code === "ARGUMENTS") return "REMOTE_GUIDED_ARGUMENTS_INVALID";
  if (error?.code === "ENOENT" || error?.code === "EACCES") return "REMOTE_GUIDED_TASK_DIR_UNAVAILABLE";
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code || "") ? error.code : "REMOTE_GUIDED_RECOVERY_FAILED";
}

export function previewGit(output, language = "en", repositoryRoot = path.resolve(import.meta.dirname, "..")) {
  try {
    const cwd = path.resolve(repositoryRoot);
    const status = execFileSync("git", ["-C", cwd, "status", "--short", "--untracked-files=all"], {
      encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    const unstaged = execFileSync("git", ["-C", cwd, "diff", "--stat", "--", "."], {
      encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
    }).trim();
    const staged = execFileSync("git", ["-C", cwd, "diff", "--cached", "--stat", "--", "."], {
      encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
    }).trim();
    const entries = status.trim() ? status.trim().split(/\r?\n/) : [];
    const untracked = entries.filter(line => line.startsWith("??")).length;
    const tracked = entries.length - untracked;
    const statusSummary = `${entries.length} changed paths (${tracked} tracked, ${untracked} untracked)`;
    const diffSummary = `unstaged: ${unstaged || "none"}; staged: ${staged || "none"}`.slice(0, 1500);
    write(output, `\n${translate(language, "recovery.git.title", { repository: path.basename(cwd), summary: statusSummary })}`);
    for (const line of entries.slice(0, 12)) write(output, translate(language, "recovery.git.entry", { entry: line.slice(0, 240) }));
    if (entries.length > 12) write(output, translate(language, "recovery.git.more", { count: entries.length - 12 }));
    write(output, translate(language, "recovery.git.diff", { summary: diffSummary }));
    write(output, translate(language, "recovery.git.note"));
    return { available: true, statusSummary, diffSummary };
  } catch {
    write(output, `\n${translate(language, "recovery.git.unavailable")}`);
    return { available: false, statusSummary: "Git status unavailable; unknown", diffSummary: "Git diff unavailable; unknown" };
  }
}

async function runScopedGuidedRecovery({ dir, state, input, output, language, inspect, inspectScoped,
  recoverScoped, username, showGitStatus, createReadline }) {
  if (state.maintenance) throw Object.assign(new Error(), { code: "REMOTE_MAINTENANCE_LOCKED_INSPECT_REQUIRED" });
  if (state.scoped?.status === "unavailable" || state.scoped?.admission_locked) {
    throw Object.assign(new Error(), { code: state.scoped?.admission_locked ? "REMOTE_REGISTRY_UNAVAILABLE" : "REMOTE_REGISTRY_UNAVAILABLE" });
  }
  const scoped = await inspectScoped(dir, state.active?.record?.workspace);
  write(output, `\n${translate(language, "recovery.heading")}`);
  write(output, translate(language, "recovery.scoped.snapshot", {
    namespace: safeFact(scoped.namespace, 120), registry: scoped.registry_sha256,
    bridge: scoped.bridge_sha256,
  }));
  for (const lease of scoped.candidates) {
    write(output, translate(language, "recovery.scoped.lease", {
      task: safeFact(lease.task_id), lease: safeFact(lease.lease_id, 120), state: safeFact(lease.state),
      request: safeFact(lease.request_id), conversation: safeFact(lease.conversation_id),
    }));
  }
  const recoverableLeases = scoped.candidates.filter(lease => lease.recoverable);
  if (!recoverableLeases.length) throw Object.assign(new Error(), { code: "REMOTE_SCOPED_UNKNOWN_LEASE_NOT_FOUND" });
  if (scoped.candidates.length !== 1 || recoverableLeases.length !== 1) {
    throw Object.assign(new Error(), { code: "REMOTE_SCOPED_OTHER_LEASES_ACTIVE" });
  }
  const candidate = recoverableLeases[0];
  const rl = createReadline({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let interrupted = false;
  rl.on("SIGINT", () => { interrupted = true; rl.close(); });
  const ask = async prompt => {
    try { return await rl.question(prompt); }
    catch { throw Object.assign(new Error(), { code: "REMOTE_GUIDED_INPUT_CANCELLED" }); }
  };
  try {
    const selectedTask = String(await ask(translate(language, "recovery.scoped.selectTask"))).trim();
    if (selectedTask !== candidate.task_id) throw Object.assign(new Error(), { code: "REMOTE_SCOPED_SELECTION_MISMATCH" });
    const selectedLease = String(await ask(translate(language, "recovery.scoped.selectLease"))).trim();
    if (selectedLease !== candidate.lease_id) throw Object.assign(new Error(), { code: "REMOTE_SCOPED_SELECTION_MISMATCH" });

    write(output, translate(language, "recovery.task", { id: candidate.task_id,
      status: safeFact(candidate.task.status, 40), finished_at: safeFact(candidate.task.finished_at || "not recorded", 80) }));
    write(output, translate(language, "recovery.scoped.target", {
      lease: candidate.lease_id, state: candidate.state, request: candidate.request_id,
      conversation: candidate.conversation_id, reason: safeFact(candidate.reason, 240),
      request_state: safeFact(candidate.request_state, 40), conversation_state: safeFact(candidate.conversation_state, 40),
    }));
    write(output, translate(language, "recovery.scoped.owner", {
      pid: candidate.owner.pid, started: safeFact(candidate.owner.started_at, 40),
      processes: candidate.processes.length, alive: candidate.owner_alive ? "alive" : "not observed alive",
    }));
    for (const process of candidate.processes.slice(0, 40)) {
      write(output, translate(language, "recovery.worker.record", {
        pid: Number.isSafeInteger(process.pid) ? process.pid : "unknown",
        parent: Number.isSafeInteger(process.parent_pid) ? process.parent_pid : "unknown",
        started: process.started_at ? `, started ${safeFact(process.started_at, 40)}` :
          process.observed_absent_at ? `, last observed absent ${safeFact(process.observed_absent_at, 40)}` : ", pending evidence",
      }));
    }
    if (candidate.processes.length > 40) write(output, translate(language, "recovery.worker.more", { count: candidate.processes.length - 40 }));
    displayScopedProcesses(output, language, scoped.current_processes, candidate);
    if (candidate.live_worker_processes.length) {
      throw Object.assign(new Error(), { code: "REMOTE_OWNED_PROCESS_STILL_ALIVE" });
    }
    if ((!candidate.task.finished_at || ["queued", "running"].includes(candidate.task.status)) && candidate.owner_alive) {
      throw Object.assign(new Error(), { code: "REMOTE_OWNER_TASK_STILL_ACTIVE" });
    }
    write(output, translate(language, "recovery.unknown.detached"));
    write(output, translate(language, "recovery.unknown.inventory"));
    write(output, translate(language, "recovery.scoped.notSuccess"));

    let gitFacts;
    try {
      gitFacts = showGitStatus(output, language, scoped.workspace) ||
        { available: false, statusSummary: "Git status unavailable; unknown", diffSummary: "Git diff unavailable; unknown" };
    } catch {
      write(output, translate(language, "recovery.git.unavailable"));
      gitFacts = { available: false, statusSummary: "Git status unavailable; unknown", diffSummary: "Git diff unavailable; unknown" };
    }
    write(output, `\n${translate(language, "recovery.checklist.title")}`);
    write(output, translate(language, "recovery.checklist.processes"));
    write(output, translate(language, "recovery.checklist.files"));
    write(output, translate(language, "recovery.checklist.external"));
    write(output, translate(language, "recovery.attestation"));
    const process_evidence = evidenceText(`Machine observed task status=${candidate.task.status}, finished_at=${candidate.task.finished_at}; owner PID=${candidate.owner.pid}, owner_alive=${candidate.owner_alive}; recorded worker PIDs=${candidate.processes.map(row => row.pid).join(",") || "none"}; detached and unrecorded work is outside machine proof. Operator manually reviewed the initial and refreshed process evidence.`);
    const file_evidence = evidenceText(`Machine observed ${safeFact(gitFacts.statusSummary, 240)}; ${safeFact(gitFacts.diffSummary, 900)}. Operator manually reviewed relevant generated files, untracked and ignored files, and changes outside Git.`);
    const external_evidence = evidenceText("No network, service, or detached-operation inventory was performed; those effects are unknown. Operator manually reviewed the displayed external-effects checklist.");
    const approval = {
      task_id: candidate.task_id, lease_id: candidate.lease_id, lease_state: candidate.state,
      namespace: scoped.namespace,
      control_sha256: scoped.control_sha256, registry_sha256: scoped.registry_sha256, bridge_sha256: scoped.bridge_sha256,
      metadata_sha256: candidate.metadata_sha256,
      owned_processes_stopped: true, untracked_processes_reviewed: true, files_reviewed: true,
      external_operations_reviewed: true, approved_by: safeFact(username(), 120),
      approval_reference: `Interactive review for task ${candidate.task_id} and lease ${candidate.lease_id}`,
      process_evidence, file_evidence, external_evidence,
    };
    write(output, `\n${translate(language, "recovery.beforeUnlock")}`);
    const result = await recoverScoped({ dir, expected: candidate.expected, task_id: candidate.task_id,
      lease_id: candidate.lease_id, approval,
      presentReview: review => {
        write(output, translate(language, "recovery.scoped.latestProbe", {
          checked_at: safeFact(review.checked_at, 48), owner_alive: review.owner_alive ? "yes" : "no",
        }));
        displayScopedProcesses(output, language, review.current_processes, candidate);
      },
      confirm: async fields => {
        if (interrupted || fields.task_id !== candidate.task_id || fields.lease_id !== candidate.lease_id ||
            fields.namespace !== scoped.namespace || fields.registry_sha256 !== scoped.registry_sha256 ||
            fields.bridge_sha256 !== scoped.bridge_sha256) return false;
        return String(await ask(translate(language, "recovery.scoped.prompt"))).trim() === "YES";
      } });
    if (result?.decision !== "released") throw Object.assign(new Error(), { code: "REMOTE_GUIDED_POST_CHECK_FAILED" });
    const after = await inspect(dir);
    if (after.active || after.maintenance || after.scoped?.lease_count !== 0 || after.scoped?.scope_bridge) {
      throw Object.assign(new Error(), { code: "REMOTE_GUIDED_POST_CHECK_FAILED" });
    }
    write(output, `\n${translate(language, "recovery.success", { auditId: result.audit_id })}`);
    write(output, translate(language, "recovery.outcomeUnknown"));
    return { recovered: true, audit_id: result.audit_id, task_id: candidate.task_id, lease_id: candidate.lease_id };
  } finally { rl.close(); }
}

function safeFact(value, maxLength = 120) {
  const result = String(value ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (result || "unknown").slice(0, maxLength);
}

function evidenceText(value) {
  return safeFact(value, 1800);
}

function displayScopedProcesses(output, language, rows, candidate) {
  write(output, translate(language, "recovery.probe"));
  for (const process of rows.slice(0, 40)) {
    const known = candidate.processes.some(row => row.pid === process.pid);
    write(output, translate(language, "recovery.process.row", {
      pid: Number.isSafeInteger(process.pid) ? process.pid : "unknown",
      parent: Number.isSafeInteger(process.parent_pid) ? process.parent_pid : "unknown",
      executable: safeFact(path.basename(process.executable || "unknown"), 80),
      match: translate(language, known ? "recovery.process.recordedWorker" :
        process.pid === candidate.owner.pid ? "recovery.process.storedOwner" : "recovery.process.discoveredDescendant"),
    }));
  }
  if (!rows.length) write(output, translate(language, "recovery.process.none"));
  else if (rows.length > 40) write(output, translate(language, "recovery.process.more", { count: rows.length - 40 }));
}

export async function runGuidedRecovery({
  input = process.stdin,
  output = process.stdout,
  isInteractive = Boolean(input.isTTY && output.isTTY),
  args = process.argv.slice(2),
  language = "en",
  inspect = inspectRecovery,
  inspectScoped = inspectScopedRecovery,
  recover = recoverExecution,
  recoverScoped = recoverScopedLease,
  username = () => os.userInfo().username,
  showGitStatus = previewGit,
  createReadline = createInterface,
} = {}) {
  if (!isInteractive) throw Object.assign(new Error(), { code: "REMOTE_LOCAL_INTERACTIVE_CONSOLE_REQUIRED" });
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--task-dir" || !args[1])) {
    throw Object.assign(new Error(), { code: "REMOTE_GUIDED_ARGUMENTS_INVALID" });
  }
  const dirInput = args.length ? args[1] :
    (process.env.THRIFTYRELAY_TASK_DIR || pathsAdapter().taskDirectory({ env: process.env, home: os.homedir() }));
  if (!path.isAbsolute(dirInput) || /[\u0000-\u001f]/.test(dirInput)) {
    throw Object.assign(new Error(), { code: "REMOTE_GUIDED_ARGUMENTS_INVALID" });
  }
  let dir;
  try { dir = await fs.realpath(dirInput); }
  catch { throw Object.assign(new Error(), { code: "REMOTE_GUIDED_TASK_DIR_UNAVAILABLE" }); }
  if ([path.parse(dir).root.toLowerCase(), os.homedir().toLowerCase()].includes(dir.toLowerCase())) {
    throw Object.assign(new Error(), { code: "REMOTE_GUIDED_ARGUMENTS_INVALID" });
  }

  const state = await inspect(dir);
  const hasScopedState = state.active?.record?.type === "scope_bridge" || state.scoped?.scope_bridge ||
    state.scoped?.lease_count > 0 || state.scoped?.status === "unavailable";
  if (hasScopedState) {
    return await runScopedGuidedRecovery({ dir, state, input, output, language, inspect, inspectScoped,
      recoverScoped, username, showGitStatus, createReadline });
  }
  if (state.maintenance) throw Object.assign(new Error(), { code: "REMOTE_MAINTENANCE_LOCKED_INSPECT_REQUIRED" });
  if (!state.active) {
    write(output, translate(language, "recovery.noLock"));
    return { recovered: false, reason: "no_active_lock" };
  }
  const lock = state.active.record;
  if (!/^task_[a-z0-9]+_[a-z0-9]{6}$/.test(lock?.task_id || "")) {
    throw Object.assign(new Error(), { code: "REMOTE_LOCK_RECORD_INCOMPLETE" });
  }
  const task = state.task;
  write(output, `\n${translate(language, "recovery.heading")}`);
  const taskStatus = safeFact(task?.status || "unknown", 40);
  const finishedAt = safeFact(task?.finished_at || "not recorded", 80);
  write(output, translate(language, "recovery.task", { id: lock.task_id, status: taskStatus, finished_at: finishedAt }));
  write(output, translate(language, "recovery.lock", { kind: safeFact(lock.kind, 40), state: safeFact(lock.state, 40), fingerprint: safeFact(state.active.sha256, 12) }));
  const owner = lock.owner || (Number.isSafeInteger(lock.owner_pid) ? { pid: lock.owner_pid } : null);
  write(output, translate(language, "recovery.owner", {
    pid: Number.isSafeInteger(owner?.pid) ? owner.pid : "unknown",
    started: owner?.started_at ? ` (${translate(language, "recovery.owner.started", { value: safeFact(owner.started_at, 40) })})` : "",
  }));
  const owned = Array.isArray(lock.processes) ? lock.processes : [];
  const workerDetails = owned.slice(0, 40).map(process => {
    const pid = Number.isSafeInteger(process.pid) ? process.pid : "unknown";
    const parent = Number.isSafeInteger(process.parent_pid) ? process.parent_pid : "unknown";
    const started = process.started_at ? `, started ${safeFact(process.started_at, 40)}` : process.observed_absent_at ? `, last observed absent ${safeFact(process.observed_absent_at, 40)}` : "";
    return translate(language, "recovery.worker.record", { pid, parent, started });
  });
  write(output, translate(language, "recovery.workers", {
    records: workerDetails.length ? workerDetails.join("; ") : translate(language, "recovery.worker.none"),
    more: owned.length > 40 ? translate(language, "recovery.worker.more", { count: owned.length - 40 }) : "",
  }));
  write(output, translate(language, "recovery.probe"));
  const currentRows = state.current_processes || [];
  for (const process of currentRows.slice(0, 40)) {
    const match = process.pid === owner?.pid ? "stored owner" : owned.some(row => row.pid === process.pid) ? "recorded worker" : "discovered descendant";
    write(output, translate(language, "recovery.process.row", {
      pid: Number.isSafeInteger(process.pid) ? process.pid : "unknown",
      parent: Number.isSafeInteger(process.parent_pid) ? process.parent_pid : "unknown",
      executable: safeFact(path.basename(process.executable || "unknown"), 80),
      match: translate(language, `recovery.process.${match === "stored owner" ? "storedOwner" : match === "recorded worker" ? "recordedWorker" : "discoveredDescendant"}`),
    }));
  }
  if (!currentRows.length) write(output, translate(language, "recovery.process.none"));
  else if (currentRows.length > 40) write(output, translate(language, "recovery.process.more", { count: currentRows.length - 40 }));
  write(output, translate(language, "recovery.unknown.detached"));
  write(output, translate(language, "recovery.unknown.inventory"));
  if (!task?.finished_at || taskStatus.toLowerCase() === "running") {
    throw Object.assign(new Error(), { code: "REMOTE_OWNER_TASK_STILL_ACTIVE" });
  }

  const stillOwned = owned.some(process => (state.current_processes || []).some(now =>
    now.pid === process.pid && !(process.observed_absent_at && now.started_at &&
      Date.parse(now.started_at) > Date.parse(process.observed_absent_at)) &&
      (!process.started_at || Date.parse(now.started_at) === Date.parse(process.started_at))));
  if (stillOwned) throw Object.assign(new Error(), { code: "REMOTE_OWNED_PROCESS_STILL_ALIVE" });

  let gitFacts;
  try {
    gitFacts = showGitStatus(output, language) || { available: false, statusSummary: "Git status unavailable; unknown", diffSummary: "Git diff unavailable; unknown" };
  } catch {
    write(output, `\n${translate(language, "recovery.git.unavailable")}`);
    gitFacts = { available: false, statusSummary: "Git status unavailable; unknown", diffSummary: "Git diff unavailable; unknown" };
  }
  write(output, `\n${translate(language, "recovery.checklist.title")}`);
  write(output, translate(language, "recovery.checklist.processes"));
  write(output, translate(language, "recovery.checklist.files"));
  write(output, translate(language, "recovery.checklist.external"));
  write(output, translate(language, "recovery.attestation"));
  const rl = createReadline({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let interrupted = false;
  rl.on("SIGINT", () => {
    interrupted = true;
    rl.close();
  });
  const ask = async prompt => {
    try { return await rl.question(prompt); }
    catch {
      throw Object.assign(new Error(), { code: "REMOTE_GUIDED_INPUT_CANCELLED" });
    }
  };
  try {
    const ownerSummary = Number.isSafeInteger(owner?.pid) ? `owner PID ${owner.pid}` : "owner PID unknown";
    const workerSummary = (owned.slice(0, 40).map(process => Number.isSafeInteger(process.pid) ? process.pid : "unknown").join(", ") || "none recorded") +
      (owned.length > 40 ? `; ${owned.length - 40} more not listed` : "");
    const process_evidence = evidenceText(`Machine observed: task status=${taskStatus}, finished_at=${finishedAt}; ${ownerSummary}; recorded worker PIDs=${workerSummary}; PID/descendant probe rows=${currentRows.length}. Operator attested after reviewing the displayed Processes checklist: recorded work and descendants were manually reviewed. Detached or unrecorded work remains outside machine proof.`);
    const file_evidence = evidenceText(`Machine observed: ${safeFact(gitFacts.statusSummary, 240)}; ${safeFact(gitFacts.diffSummary, 900)}. Operator attested after reviewing the displayed Files checklist: relevant Git, untracked, ignored, and non-Git paths were manually reviewed.`);
    const external_evidence = evidenceText("Machine observed: no network, service, or detached-operation inventory was performed; those effects are unknown. Operator attested after reviewing the displayed External effects checklist: these operations were manually reviewed.");
    const approval = {
      task_id: lock.task_id,
      lock_sha256: state.active.sha256,
      owned_processes_stopped: true,
      untracked_processes_reviewed: true,
      files_reviewed: true,
      external_operations_reviewed: true,
      approved_by: safeFact(username(), 120),
      approval_reference: `Interactive yes/no attestation to displayed recovery review for ${lock.task_id}`,
      process_evidence,
      file_evidence,
      external_evidence,
    };
    write(output, `\n${translate(language, "recovery.beforeUnlock")}`);
    const result = await recover({ dir, approval, confirm: async ({ task_id, lock_sha256 }) => {
      if (task_id !== lock.task_id || lock_sha256 !== state.active.sha256) return false;
      const answer = String(await ask(translate(language, "recovery.prompt"))).trim();
      return !interrupted && /^(?:y|yes)$/i.test(answer);
    } });
    if (result?.decision !== "released") {
      throw Object.assign(new Error(), { code: "REMOTE_GUIDED_POST_CHECK_FAILED" });
    }
    let after;
    try { after = await inspect(dir); }
    catch { throw Object.assign(new Error(), { code: "REMOTE_GUIDED_POST_CHECK_FAILED" }); }
    if (after.active || after.maintenance) {
      throw Object.assign(new Error(), { code: "REMOTE_GUIDED_POST_CHECK_FAILED" });
    }
    write(output, `\n${translate(language, "recovery.success", { auditId: result.audit_id })}`);
    write(output, translate(language, "recovery.outcomeUnknown"));
    return { recovered: true, audit_id: result.audit_id };
  } finally {
    rl.close();
  }
}

async function main() {
  let language = "en";
  try {
    const parsed = parseLanguageFlags(process.argv.slice(2));
    language = (await resolveLanguagePreference({ explicitLanguage: parsed.explicitLanguage })).language;
    await runGuidedRecovery({ args: parsed.args, language });
  } catch (error) {
    if (error.code === "LANG_UNSUPPORTED" || error.code === "LANG_ARGUMENTS_INVALID") {
      language = (await resolveLanguagePreference().catch(() => ({ language: "en" }))).language;
      console.error(formatLanguageError(error, language));
      process.exitCode = 2;
      return;
    }
    console.error(failure(errorCode(error), language) +
      (error.audit_id ? `\nAudit ID: ${safeFact(error.audit_id, 120)}` : "") +
      (error.audit_update_unconfirmed ? `\n${translate(language, "recovery.failure.auditUpdateUnconfirmed")}` : ""));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main().catch(async error => {
    const { language } = await resolveLanguagePreference().catch(() => ({ language: "en" }));
    console.error(failure(errorCode(error), language) +
      (error.audit_id ? `\nAudit ID: ${safeFact(error.audit_id, 120)}` : "") +
      (error.audit_update_unconfirmed ? `\n${translate(language, "recovery.failure.auditUpdateUnconfirmed")}` : ""));
    process.exitCode = 1;
  });
}

export { errorCode, failure };
