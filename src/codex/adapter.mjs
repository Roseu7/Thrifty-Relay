import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { fork } from "node:child_process";
import { writeRecord } from "../mcp/task-storage.mjs";
import { createExecutionGuard, ownerIdentity, probeProcesses } from "../mcp/execution-guard.mjs";
import { caseFold, terminateProcessTree } from "../platform/index.mjs";
import { createScopedLeaseRegistry, validateWriteScopes } from "../mcp/scope-leases.mjs";
import { snapshotFiles, compareFiles, reviewSummary } from "./review-evidence.mjs";
import { sanitizeDiagnostic } from "./diagnostics.mjs";
import { CODEX_MODEL_OPTIONS, DEFAULT_SETTINGS, readSetupConfig } from "../config.mjs";
import { getConfigPath } from "../i18n/index.mjs";
import { evaluateCodexQuota } from "./quota-gate.mjs";

const ENV_NAMES = new Set([
  "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "OS", "PROCESSOR_ARCHITECTURE",
]);
const hash = value => createHash("sha256").update(value).digest("hex");
const CODEX_MODELS = new Set(CODEX_MODEL_OPTIONS.map(option => option.slice(0, option.indexOf("/"))));
const CODEX_REASONING_EFFORTS = new Set(CODEX_MODEL_OPTIONS.map(option => option.slice(option.indexOf("/") + 1)));
const CODEX_TASK_ID = /^task_[a-z0-9]+_[a-z0-9]{6}$/;
const REQUEST_STATES = new Set(["quota_warning_pending", "reserved", "running", "completed", "not_started",
  "dispatch_unknown", "execution_unknown", "stopped_effects_unknown", "reviewed_unknown"]);
const response = (text, isError = false, structuredContent) => ({ content: [{ type: "text", text }],
  ...(isError ? { isError } : {}), ...(structuredContent ? { structuredContent } : {}) });
function reject(code) { throw Object.assign(new Error(code), { code }); }
const approvalAttestation = "ChatGPT-reported user approval; this program cannot cryptographically verify the user's intent.";
function validQuotaWindows(rows) {
  return Array.isArray(rows) && rows.length === 2 && ["five_hour", "weekly"].every(name =>
    rows.filter(row => row?.name === name).length === 1) && rows.every(row => row &&
      ["five_hour", "weekly"].includes(row.name) && Number.isFinite(row.remaining_percent) &&
      row.remaining_percent >= 0 && row.remaining_percent <= 100 && Number.isInteger(row.threshold_percent) &&
      row.threshold_percent >= 0 && row.threshold_percent <= 100 && ["warn", "block"].includes(row.action) &&
      (row.resets_at === null || typeof row.resets_at === "string"));
}

export function cleanCodexText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export async function waitForWorkerProcesses(processes, {
  probe = probeProcesses, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), timeoutMs = 5000,
} = {}) {
  if (processes.some(row => !Number.isFinite(Date.parse(row.started_at || row.observed_absent_at)))) {
    reject("CODEX_PROCESS_EVIDENCE_UNKNOWN");
  }
  const observed = processes.filter(row => row.started_at);
  if (!observed.length) return true;
  const deadline = now() + timeoutMs;
  for (;;) {
    const current = await probe(observed.map(row => row.pid), true);
    if (current.some(row => observed.some(old => old.pid === row.pid) && !Number.isFinite(Date.parse(row.started_at)))) {
      reject("CODEX_PROCESS_EVIDENCE_UNKNOWN");
    }
    if (!current.some(row => observed.some(old => old.pid === row.pid &&
        Date.parse(old.started_at) === Date.parse(row.started_at)))) return true;
    if (now() >= deadline) return false;
    await sleep(Math.min(100, deadline - now()));
  }
}

export function createCodexAdapter({ dir, taskId,
  workerFile = new URL("./worker.mjs", import.meta.url),
  quotaReader,
  configFile = getConfigPath() }) {
  const store = path.join(dir, "codex");
  const requests = path.join(store, "requests");
  const guard = createExecutionGuard({ dir });
  const requestFile = id => path.join(requests, hash(id) + ".json");
  const approvalLockFile = id => requestFile(id) + ".approval.lock";
  const saveConversation = record => writeRecord(path.join(store, record.id + ".json"), record);

  async function readRequest(id) {
    const file = requestFile(id);
    let handle;
    try {
      const before = await fs.lstat(file);
      if (before.isSymbolicLink() || !before.isFile() || before.size > 16384) reject("CODEX_REQUEST_RECORD_INVALID");
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
      handle = await fs.open(file, flags);
      const opened = await handle.stat();
      if (!opened.isFile()) reject("CODEX_REQUEST_RECORD_INVALID");
      const source = await handle.readFile("utf8");
      const after = await fs.lstat(file);
      if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
        reject("CODEX_REQUEST_RECORD_INVALID");
      }
      const record = JSON.parse(source);
      if (!record || typeof record !== "object" || Array.isArray(record) || record.request_id !== id ||
          record.version !== 3 || !/^[a-f0-9]{64}$/.test(record.fingerprint || "") ||
          !REQUEST_STATES.has(record.state)) reject("CODEX_REQUEST_RECORD_INVALID");
      if (record.state === "quota_warning_pending") {
        if (record.version !== 3 || Object.hasOwn(record, "task_id") || !record.challenge ||
            !/^[a-f0-9]{64}$/.test(record.challenge.token_hash || "") ||
            typeof record.challenge.issued_at !== "string" ||
            !(record.challenge.checked_at === null || typeof record.challenge.checked_at === "string") ||
            !validQuotaWindows(record.challenge.windows) || record.quota_warning_approved !== false) {
          reject("CODEX_REQUEST_RECORD_INVALID");
        }
      } else if (!CODEX_TASK_ID.test(record.task_id || "") ||
          (record.quota_warning_approved !== undefined && typeof record.quota_warning_approved !== "boolean")) {
        reject("CODEX_REQUEST_RECORD_INVALID");
      }
      if (record.quota_warning_approved !== undefined && record.state !== "quota_warning_pending" &&
          (record.version !== 3 || !validQuotaWindows(record.quota_windows) ||
           !(record.quota_checked_at === null || typeof record.quota_checked_at === "string"))) {
        reject("CODEX_REQUEST_RECORD_INVALID");
      }
      if (record.quota_warning_approved === true &&
          (!/^[a-f0-9]{64}$/.test(record.quota_approval_token_hash || "") ||
           typeof record.quota_approval_reported_at !== "string" ||
           typeof record.quota_approval_challenge_issued_at !== "string" ||
           record.quota_approval_attestation !== approvalAttestation)) reject("CODEX_REQUEST_RECORD_INVALID");
      return record;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (typeof error?.code === "string" && error.code.startsWith("CODEX_")) throw error;
      reject("CODEX_REQUEST_RECORD_INVALID");
    } finally { await handle?.close().catch(() => {}); }
  }

  async function saveRequest(record) {
    const current = await readRequest(record.request_id);
    if (!current || current.fingerprint !== record.fingerprint) reject("CODEX_REQUEST_RECORD_INVALID");
    await writeRecord(requestFile(record.request_id), record);
  }

  async function readApprovalLock(id) {
    const file = approvalLockFile(id);
    let handle;
    try {
      const before = await fs.lstat(file);
      if (before.isSymbolicLink() || !before.isFile() || before.size > 4096) reject("CODEX_QUOTA_APPROVAL_LOCK_INVALID");
      handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile()) reject("CODEX_QUOTA_APPROVAL_LOCK_INVALID");
      const source = await handle.readFile("utf8");
      const after = await fs.lstat(file);
      if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) reject("CODEX_QUOTA_APPROVAL_LOCK_INVALID");
      const claim = JSON.parse(source);
      if (claim?.request_id !== id || !/^[a-f0-9]{64}$/.test(claim.fingerprint || "") ||
          !/^[a-f0-9-]{36}$/.test(claim.nonce || "")) reject("CODEX_QUOTA_APPROVAL_LOCK_INVALID");
      return claim;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (typeof error?.code === "string" && error.code.startsWith("CODEX_")) throw error;
      reject("CODEX_QUOTA_APPROVAL_LOCK_INVALID");
    } finally { await handle?.close().catch(() => {}); }
  }

  async function acquireApprovalLock(id, fingerprint) {
    const file = approvalLockFile(id);
    const nonce = randomUUID();
    for (let attempt = 0; attempt < 240; attempt++) {
      const current = await readRequest(id);
      if (!current || current.fingerprint !== fingerprint) reject("CODEX_REQUEST_RECORD_INVALID");
      if (current.state !== "quota_warning_pending") return { current };
      try {
        await writeRecord(file, { request_id: id, fingerprint, nonce }, true);
        const reread = await readRequest(id);
        if (!reread || reread.fingerprint !== fingerprint) reject("CODEX_REQUEST_RECORD_INVALID");
        if (reread.state !== "quota_warning_pending") {
          const lock = await readApprovalLock(id);
          if (lock?.nonce === nonce) await fs.unlink(file);
          return { current: reread };
        }
        return {
          current: reread,
          release: async () => {
            const lock = await readApprovalLock(id);
            if (lock?.nonce === nonce) await fs.unlink(file);
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") {
          const owned = await readApprovalLock(id).catch(() => null);
          if (owned?.nonce === nonce) await fs.unlink(file).catch(() => {});
          throw error;
        }
        const claim = await readApprovalLock(id);
        if (!claim || claim.fingerprint !== fingerprint) reject("CODEX_QUOTA_APPROVAL_LOCK_INVALID");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    reject("CODEX_QUOTA_APPROVAL_IN_PROGRESS");
  }

  async function readQuotaSettings() {
    try { return { ...DEFAULT_SETTINGS, ...await readSetupConfig(configFile) }; }
    catch { reject("CODEX_QUOTA_CONFIG_UNAVAILABLE"); }
  }

  // ChatGPT picks a role rather than a model: the base model for ordinary work and the upper
  // model for escalation, read from the saved settings when the request arrives. A new
  // conversation without a role uses the base model; a continuation without one keeps the
  // model and effort it last ran with.
  async function applyModelRole(step) {
    const role = step.model_role ?? (step.conversation_id || step.model ? undefined : "base");
    if (!role) return step;
    if (role !== "base" && role !== "upper") reject("CODEX_MODEL_ROLE_UNSUPPORTED");
    let settings;
    try { settings = { ...DEFAULT_SETTINGS, ...await readSetupConfig(configFile) }; }
    catch { reject("CODEX_MODEL_SETTINGS_UNAVAILABLE"); }
    const pair = role === "upper" ? settings.upperModel : settings.baseModel;
    if (pair === "disabled") reject("CODEX_UPPER_MODEL_DISABLED");
    const [model, reasoning_effort] = pair.split("/");
    return { ...step, model, reasoning_effort };
  }

  function quotaResponse(decision, requestId, token) {
    const rows = decision.windows || [];
    const labels = { five_hour: "5h", weekly: "1w" };
    const values = rows.map(row => `${labels[row.name] || row.name}: remaining ${row.remaining_percent === null ? "unavailable" : `${row.remaining_percent}%`}, ` +
      `threshold ${row.threshold_percent}%, action ${row.action}, reset ${row.resets_at || "unknown"}`).join("\n");
    const details = { code: decision.code, request_id: requestId, windows: rows,
      ...(decision.checked_at ? { checked_at: decision.checked_at } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(token ? { quota_approval_token: token } : {}),
      ...(decision.code === "CODEX_QUOTA_APPROVAL_REQUIRED" ? { explicit_user_approval_required: true } : {}) };
    const explanation = decision.code === "CODEX_QUOTA_APPROVAL_REQUIRED"
      ? "Ask the user before continuing. No task was created and no worker was started."
      : decision.code === "CODEX_QUOTA_BLOCKED"
        ? "A configured block threshold was reached. No task was created and approval cannot override it."
        : "Both Codex quota windows must be available before dispatch. No task was created.";
    const text = `${decision.code}\n${explanation}\n${values}\n${decision.code.endsWith("APPROVAL_REQUIRED") && token ?
      `Repeat the exact same request_id and task intent after explicit consent, adding quota_warning_approved=true and the quota_approval_token.\n` : ""}` +
      `${decision.code}_JSON=${JSON.stringify(details)}`;
    return response(text, decision.code !== "CODEX_QUOTA_APPROVAL_REQUIRED", details);
  }

  async function preflight(step, { conversation = true } = {}) {
    if (step.readOnly) reject("CODEX_READONLY_UNAVAILABLE");
    if (step.model && !CODEX_MODELS.has(step.model)) reject("CODEX_MODEL_UNSUPPORTED");
    if (step.reasoning_effort && !CODEX_REASONING_EFFORTS.has(step.reasoning_effort)) reject("CODEX_REASONING_UNSUPPORTED");
    if (step.model && step.reasoning_effort && !CODEX_MODEL_OPTIONS.includes(`${step.model}/${step.reasoning_effort}`)) {
      reject("CODEX_MODEL_EFFORT_UNSUPPORTED");
    }
    if (step.expected_files && (!Array.isArray(step.expected_files) || step.expected_files.length > 100 ||
      step.expected_files.some(name => typeof name !== "string" || name.length > 240 || !name || /[\\:\u0000]/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || [".", ".."].includes(part))))) reject("CODEX_EXPECTED_FILES_INVALID");
    if (step.permissions !== "full-access") reject("CODEX_EXPLICIT_FULL_ACCESS_REQUIRED");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(step.request_id || "")) reject("CODEX_REQUEST_ID_REQUIRED");
    const root = process.env.THRIFTYRELAY_CODEX_WORKSPACE;
    if (!root) reject("CODEX_DISABLED");
    if (!path.isAbsolute(step.cwd) || !path.isAbsolute(root)) reject("CODEX_ABSOLUTE_CWD_REQUIRED");
    const cwd = await fs.realpath(step.cwd).catch(() => reject("CODEX_CWD_NOT_FOUND"));
    const allowed = await fs.realpath(root).catch(() => reject("CODEX_WORKSPACE_NOT_FOUND"));
    // Temporary work is a second permitted target, not a wider sandbox: the tier still picks
    // the sandbox, and the resolved path must stay inside the configured temporary root.
    const scratchRoot = process.env.THRIFTYRELAY_TEMP_WORKSPACE;
    let allowedScratch = null;
    if (typeof scratchRoot === "string" && scratchRoot) {
      if (!path.isAbsolute(scratchRoot)) reject("CODEX_ABSOLUTE_CWD_REQUIRED");
      allowedScratch = await fs.realpath(scratchRoot).catch(() => null);
    }
    const inside = (base, target) => {
      const relative = path.relative(base, target);
      return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    };
    const inWorkspace = cwd.toLowerCase() === allowed.toLowerCase();
    const inScratch = allowedScratch !== null && inside(allowedScratch, cwd);
    if ((!inWorkspace && !inScratch) || cwd === path.parse(cwd).root ||
        cwd.toLowerCase() === os.homedir().toLowerCase()) reject("CODEX_WORKSPACE_NOT_ALLOWED");
    if (!(await fs.stat(cwd)).isDirectory()) reject("CODEX_CWD_NOT_DIRECTORY");
    if (Object.hasOwn(step, "write_scopes")) await validateWriteScopes(cwd, step.write_scopes);
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    let auth;
    try { auth = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8")); }
    catch { reject("CODEX_CHATGPT_AUTH_REQUIRED"); }
    if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token || auth.OPENAI_API_KEY) reject("CODEX_CHATGPT_AUTH_REQUIRED");
    let record = null;
    if (conversation && step.conversation_id) {
      if (!/^cx_[a-f0-9]{32}$/.test(step.conversation_id)) reject("CODEX_INVALID_CONVERSATION");
      try { record = JSON.parse(await fs.readFile(path.join(store, step.conversation_id + ".json"), "utf8")); }
      catch { reject("CODEX_CONVERSATION_NOT_OWNED"); }
      // Never upgrade a Phase 1 thread's different permission contract.
      if (record.version !== 2 || record.id !== step.conversation_id || !record.thread_id ||
          record.cwd.toLowerCase() !== cwd.toLowerCase() || record.readOnly !== false ||
          record.permissions !== step.permissions) reject("CODEX_CONVERSATION_MISMATCH");
      if (record.state !== "idle") reject("CODEX_CONVERSATION_INTERRUPTED_INSPECT_FIRST");
    }
    return { cwd, home, record };
  }

  async function submit(args, runTask) {
    try {
      if (args.steps.length !== 1 || args.steps[0].kind !== "codex" || args.execution !== "async") reject("CODEX_REQUIRES_ONE_ASYNC_STEP");
      // The resolved step is what the task stores and later runs, so the role is fixed here.
      const step = await applyModelRole(args.steps[0]);
      args = { ...args, steps: [step] };
      // A Codex task already has an explicit cwd and a policy-selected sandbox. Creating a
      // second per-task scratch directory here would leave the actual work and the cleanup
      // target in different places, so the caller must name an absolute cwd instead.
      if (args.scratch) reject("CODEX_SCRATCH_UNSUPPORTED");
      const { cwd } = await preflight(step, { conversation: false });
      const fingerprint = hash(JSON.stringify({ prompt: step.prompt, cwd: cwd.toLowerCase(),
        conversation_id: step.conversation_id || null, permissions: step.permissions,
        model: step.model || null, effort: step.reasoning_effort || null, task_type: step.task_type || "question",
        expected_files: step.expected_files || null, timeout: args.task_timeout_ms ?? 1800000,
        ...(Object.hasOwn(step, "write_scopes") ? { write_scopes: step.write_scopes } : {}) }));
      await fs.mkdir(requests, { recursive: true });
      const matches = previous => previous.fingerprint === fingerprint;
      const duplicate = previous => response(`Task ${previous.task_id}: duplicate request; not executed again. ` +
        `Last recorded admission: ${previous.state}; inspect current state with remote_inspect. Expired output never permits re-execution.`);
      const pendingWarning = previous => quotaResponse({ code: "CODEX_QUOTA_APPROVAL_REQUIRED",
        checked_at: previous.challenge.checked_at, windows: previous.challenge.windows }, step.request_id);
      const existingResult = previous => {
        if (!matches(previous)) reject("CODEX_REQUEST_ID_CONFLICT");
        return previous.state === "quota_warning_pending" ? pendingWarning(previous) : duplicate(previous);
      };
      const existing = await readRequest(step.request_id);
      if (existing) {
        if (!matches(existing)) reject("CODEX_REQUEST_ID_CONFLICT");
        if (existing.state !== "quota_warning_pending") return duplicate(existing);
        if (step.quota_warning_approved !== true) {
          if (Object.hasOwn(step, "quota_approval_token")) reject("CODEX_QUOTA_APPROVAL_INVALID");
          return pendingWarning(existing);
        }
        const suppliedToken = step.quota_approval_token;
        if (typeof suppliedToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(suppliedToken)) {
          reject("CODEX_QUOTA_APPROVAL_INVALID");
        }
        const suppliedHash = Buffer.from(hash(suppliedToken), "hex");
        const issuedHash = Buffer.from(existing.challenge.token_hash, "hex");
        if (!timingSafeEqual(suppliedHash, issuedHash)) reject("CODEX_QUOTA_APPROVAL_INVALID");
        const claim = await acquireApprovalLock(step.request_id, fingerprint);
        if (!claim.release) return existingResult(claim.current);
        try {
          const current = await readRequest(step.request_id);
          if (!current || current.fingerprint !== fingerprint) reject("CODEX_REQUEST_RECORD_INVALID");
          if (current.state !== "quota_warning_pending") return existingResult(current);
          const currentHash = Buffer.from(current.challenge.token_hash, "hex");
          if (!timingSafeEqual(suppliedHash, currentHash)) reject("CODEX_QUOTA_APPROVAL_INVALID");
          const settings = await readQuotaSettings();
          const decision = await evaluateCodexQuota({ settings, quotaReader });
          if (!decision.allowed && decision.code !== "CODEX_QUOTA_APPROVAL_REQUIRED") {
            return quotaResponse(decision, step.request_id);
          }
          return await reserveAndDispatch(args, step, fingerprint, runTask, {
            previous: current, decision, approved: true,
          });
        } finally { await claim.release(); }
      }

      if (step.quota_warning_approved === true || Object.hasOwn(step, "quota_approval_token")) {
        reject("CODEX_QUOTA_APPROVAL_INVALID");
      }
      const settings = await readQuotaSettings();
      const decision = await evaluateCodexQuota({ settings, quotaReader });
      if (!decision.allowed && decision.code !== "CODEX_QUOTA_APPROVAL_REQUIRED") {
        return quotaResponse(decision, step.request_id);
      }
      if (decision.code === "CODEX_QUOTA_APPROVAL_REQUIRED") {
        const token = randomBytes(32).toString("base64url");
        const request = { version: 3, request_id: step.request_id, fingerprint,
          state: "quota_warning_pending", created_at: new Date().toISOString(), quota_warning_approved: false,
          challenge: { token_hash: hash(token), issued_at: new Date().toISOString(),
            checked_at: decision.checked_at, windows: decision.windows } };
        try {
          await writeRecord(requestFile(step.request_id), request, true);
          return quotaResponse(decision, step.request_id, token);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const raced = await readRequest(step.request_id);
          if (!raced) reject("CODEX_REQUEST_RECORD_INVALID");
          return existingResult(raced);
        }
      }
      return await reserveAndDispatch(args, step, fingerprint, runTask, { decision, approved: false });
    } catch (error) { return response(safeCode(error), true); }
  }

  async function reserveAndDispatch(args, step, fingerprint, runTask,
    { previous = null, decision, approved }) {
    const now = new Date().toISOString();
    const request = {
      version: 3, request_id: step.request_id, fingerprint,
      task_id: taskId(), state: "reserved", created_at: previous?.created_at || now,
      quota_warning_approved: approved,
      quota_checked_at: decision.checked_at ?? null,
      quota_windows: decision.windows,
      ...(approved ? {
        quota_approval_token_hash: previous.challenge.token_hash,
        quota_approval_reported_at: now,
        quota_approval_challenge_issued_at: previous.challenge.issued_at,
        quota_approval_attestation: approvalAttestation,
      } : {}),
    };
    try {
      if (previous) await saveRequest(request);
      else await writeRecord(requestFile(step.request_id), request, true);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const raced = await readRequest(step.request_id);
      if (!raced) reject("CODEX_REQUEST_RECORD_INVALID");
      if (raced.fingerprint !== fingerprint) reject("CODEX_REQUEST_ID_CONFLICT");
      if (raced.state === "quota_warning_pending") {
        return quotaResponse({ code: "CODEX_QUOTA_APPROVAL_REQUIRED", checked_at: raced.challenge.checked_at,
          windows: raced.challenge.windows }, step.request_id);
      }
      return response(`Task ${raced.task_id}: duplicate request; not executed again. ` +
        `Last recorded admission: ${raced.state}; inspect current state with remote_inspect. Expired output never permits re-execution.`);
    }
    // The durable reservation and quota check both precede task/worker dispatch.
    try {
      const result = await runTask(args, { id: request.task_id, codex_request_id: step.request_id,
        quota_warning_approved: approved });
      if (result.isError) { request.state = "not_started"; await saveRequest(request); }
      return result;
    } catch {
      request.state = "dispatch_unknown"; await saveRequest(request);
      reject("CODEX_DISPATCH_UNCONFIRMED_NO_RETRY");
    }
  }

  async function execute(step, context) {
    let request, record, lock, returned, before, review, effectiveCwd, diagnostic;
    let started = false, release = false, conversationClaimed = false;
    // Unregistered hosts keep the previous behaviour. Once a registration exists, the sandbox
    // is decided by the tier and never by what the request asked for.
    const sandbox = context.sandbox || "danger-full-access";
    const scoped = Object.hasOwn(step, "write_scopes");
    const workerProcesses = [];
    const saveReview = async outcome => {
      if (!before || review) return review;
      try {
        const report = { task_id: context.task_id, scope: effectiveCwd, at: new Date().toISOString(),
          files: compareFiles(before, await snapshotFiles(effectiveCwd), step.expected_files),
          commands: outcome?.commands || [], commands_omitted: outcome?.commands_omitted || 0,
          command_evidence_complete: outcome?.completed === true && !outcome?.commands_omitted,
          command_source: "SDK command_execution events; may be incomplete after interruption; not a test verdict",
          quota_warning_approved: request?.quota_warning_approved === true,
          ...(request?.quota_warning_approved === true ? { quota_approval_attestation: approvalAttestation } : {}) };
        if (scoped) {
          const contains = name => step.write_scopes === "global" || step.write_scopes.some(scope => {
            const file = caseFold(name);
            const declared = caseFold(scope.path.replaceAll("\\", "/"));
            return file === declared || scope.kind === "directory" && file.startsWith(declared + "/");
          });
          report.admission = { write_scopes: step.write_scopes, enforcement: "declaration_only",
            outside_declaration_observed: report.files.changes.filter(item => !contains(item.path)).map(item => item.path),
            attribution: "unverified: concurrent peers or external writers may have changed these files",
            strict_scope_verified: false };
        }
        const reviewDir = path.join(store, "reviews"); await fs.mkdir(reviewDir, { recursive: true });
        const file = path.join(reviewDir, context.task_id + ".json");
        await writeRecord(file, report);
        review = { path: file, summary: reviewSummary(report),
          quota_warning_approved: report.quota_warning_approved,
          ...(report.quota_approval_attestation ? { quota_approval_attestation: report.quota_approval_attestation } : {}),
          ...(report.admission ? { admission: {
          enforcement: "declaration_only", strict_scope_verified: false,
          outside_declaration_count: report.admission.outside_declaration_observed.length,
          outside_declaration_observed: report.admission.outside_declaration_observed.slice(0, 5).map(name => name.slice(0, 160)),
          attribution: report.admission.attribution,
        } } : {}) };
      } catch { review = { error: "CODEX_REVIEW_UNAVAILABLE", summary: { complete: false } }; }
      return review;
    };
    try {
      const claim = await readRequest(step.request_id);
      if (claim?.task_id !== context.task_id || claim.state !== "reserved" ||
          claim.quota_warning_approved !== (step.quota_warning_approved === true)) reject("CODEX_ADMISSION_MISMATCH");
      request = claim;
      if (request.quota_warning_approved === true) {
        if (typeof step.quota_approval_token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(step.quota_approval_token) ||
            !timingSafeEqual(Buffer.from(hash(step.quota_approval_token), "hex"), Buffer.from(request.quota_approval_token_hash, "hex"))) {
          reject("CODEX_ADMISSION_MISMATCH");
        }
      } else if (Object.hasOwn(step, "quota_approval_token")) reject("CODEX_ADMISSION_MISMATCH");
      const { cwd, home, record: previous } = await preflight(step);
      if (context.signal?.aborted) reject("CODEX_CANCELLED_BEFORE_START");
      const conversationId = previous?.id || "cx_" + randomUUID().replaceAll("-", "");
      try {
        if (scoped) {
          const registry = createScopedLeaseRegistry({ dir, workspace: cwd });
          const lease = await registry.acquire({ task_id: context.task_id, request_id: step.request_id,
            conversation_id: conversationId, scopes: step.write_scopes, kind: "codex", owner: await ownerIdentity() });
          lock = {
            release: () => registry.release(lease), retain: reason => registry.retain(lease, reason),
            noteProcess: async (pid, descendants = false) => {
              const rows = await registry.noteProcess(lease, pid, descendants);
              for (const row of rows) {
                if (!workerProcesses.some(old => old.pid === row.pid && old.started_at === row.started_at)) workerProcesses.push(row);
              }
            },
          };
        } else lock = await guard.acquire({ task_id: context.task_id, kind: "codex", cwd });
      }
      catch (error) {
        if (error.code === "REMOTE_EXECUTION_LOCKED") reject("CODEX_EXECUTION_LOCKED");
        if (error.code === "REMOTE_MAINTENANCE_LOCKED") reject("CODEX_MAINTENANCE_LOCKED");
        throw error;
      }
      release = true;
      // Re-read after admission: an earlier turn may have finished between preflight and acquisition.
      const current = previous ? (await preflight(step)).record : null;
      record = current || { version: 2, id: conversationId,
        cwd, readOnly: false, permissions: step.permissions, sandbox, thread_id: null };
      const model = step.model || record.model || "gpt-6.1-sol";
      const effort = step.reasoning_effort || (step.model && step.model !== record.model ? null : record.reasoning_effort) ||
        (model === "gpt-6-luna" ? "max" : "medium");
      if (!CODEX_MODELS.has(model)) reject("CODEX_MODEL_UNSUPPORTED");
      if (!CODEX_MODEL_OPTIONS.includes(`${model}/${effort}`)) reject("CODEX_MODEL_EFFORT_UNSUPPORTED");
      conversationClaimed = true;
      record.state = "running";
      await saveConversation(record);
      request.state = "running";
      request.conversation_id = record.id;
      request.model = model; request.reasoning_effort = effort;
      await saveRequest(request);
      effectiveCwd = cwd;
      if (step.task_type === "code") before = await snapshotFiles(cwd);
      const env = Object.fromEntries(Object.entries(process.env)
        .filter(([name, value]) => ENV_NAMES.has(name.toUpperCase()) && value !== undefined));
      env.CODEX_HOME = home;
      const outcome = await runWorker({ workerFile, env, payload: { cwd, thread_id: record.thread_id, prompt: step.prompt, model, reasoning_effort: effort,
        sandbox,
        ...(scoped ? { write_scopes: step.write_scopes } : {}) },
        signal: context.signal, onStart: async pid => { started = true; release = false; await lock.noteProcess(pid); },
        onProgress: scoped ? pid => lock.noteProcess(pid, true) : undefined,
        onThread: async (threadId, pid) => {
          record.thread_id = threadId; await saveConversation(record); await lock.noteProcess(pid, true);
        } });
      release = (outcome.terminated || outcome.completed) && outcome.process_evidence_complete;
      if (scoped && release) {
        release = false;
        // A closed wrapper alone does not prove its descendants stopped; allow a bounded
        // drain period for console hosts and process enumeration after the wrapper closes.
        if (!await waitForWorkerProcesses(workerProcesses)) {
          release = false;
          reject("CODEX_WORKER_PROCESSES_STILL_ACTIVE");
        }
        release = true;
      }
      if (!release && outcome.completed) reject("CODEX_PROCESS_EVIDENCE_UNKNOWN");
      diagnostic = sanitizeDiagnostic(outcome.diagnostic);
      await saveReview(outcome);
      if (!outcome.completed) reject(outcome.terminated ? "CODEX_CANCELLED" :
        ["CODEX_MODEL_UNAVAILABLE", "CODEX_USAGE_LIMIT", "CODEX_AUTH_FAILED", "CODEX_TURN_FAILED"].includes(outcome.error_code) ? outcome.error_code : "CODEX_EXECUTION_UNKNOWN");
      record.state = "idle";
      record.model = model; record.reasoning_effort = effort;
      await saveConversation(record);
      const output = { conversation_id: record.id, model, reasoning_effort: effort,
        permissions: step.permissions, sandbox, mode: "normal", execution_state: "completed",
        quota_warning_approved: request.quota_warning_approved === true,
        ...(request.quota_warning_approved === true ? { quota_approval_attestation: approvalAttestation } : {}),
        ...(scoped ? { scope_enforcement: "admission_declaration_only",
          scope_count: Array.isArray(step.write_scopes) ? step.write_scopes.length : 0, scope_global: step.write_scopes === "global" } : {}),
        answer: cleanCodexText(outcome.answer).slice(0, 8000), truncated: outcome.truncated, usage: outcome.usage,
        ...(outcome.limits ? { limits: outcome.limits } : {}),
        ...(review ? { review } : {}) };
      while (JSON.stringify(output).length > 10000) {
        output.answer = output.answer.slice(0, Math.floor(output.answer.length * 0.8)); output.truncated = true;
      }
      request.state = "completed";
      await saveRequest(request);
      return returned = { failed: false, summary: `codex: PASS (${record.id}; ${model}/${effort}; normal)`, result: response(JSON.stringify(output)) };
    } catch (error) {
      const code = safeCode(error);
      await saveReview();
      if (conversationClaimed) { record.state = "interrupted"; await saveConversation(record).catch(() => { release = false; }); }
      if (request) {
        const durable = await readRequest(step.request_id).catch(() => null);
        const unchanged = durable && durable.task_id === context.task_id && durable.request_id === request.request_id &&
          durable.fingerprint === request.fingerprint && ["reserved", "running"].includes(durable.state);
        if (!unchanged) release = false;
        else {
          request.state = started ? (release ? "stopped_effects_unknown" : "execution_unknown") : "not_started";
          request.error = code;
          try { await saveRequest(request); } catch { release = false; }
        }
      }
      const status = context.signal?.aborted ? (context.reason?.() || "cancelled") : "failed";
      return returned = { failed: true, status, execution_unknown: !!lock && !release,
        summary: `codex: ERROR ${code}; ${started ? "inspect changes before a new request" : "not started"}${lock && !release ? "; execution lock retained" : ""}`,
        result: response(JSON.stringify({ error: code, conversation_id: record?.id,
          execution_state: started ? "effects_unknown" : "not_started", lock_retained: !!lock && !release,
          quota_warning_approved: request?.quota_warning_approved === true,
          ...(request?.quota_warning_approved === true ? { quota_approval_attestation: approvalAttestation } : {}),
          retry: "never_automatically_reexecute", ...(diagnostic ? { diagnostic } : {}),
          ...(review ? { review } : {}) }), true) };
    } finally {
      if (lock) {
        try {
          if (release) await lock.release();
          else await lock.retain("CODEX_EXECUTION_UNKNOWN");
        } catch {
          if (returned) {
            returned.failed = true; returned.execution_unknown = true;
            returned.summary += "; lock release/state unconfirmed; local recovery required";
            const output = JSON.parse(returned.result.content[0].text);
            output.lock_retained = true; output.recovery_required = true;
            returned.result = response(JSON.stringify(output), true);
          }
        }
      }
    }
  }
  return { preflight, submit, execute };
}

function safeCode(error) {
  if (typeof error?.code === "string" && /^REMOTE_[A-Z_]+$/.test(error.code)) return error.code.replace(/^REMOTE_/, "CODEX_");
  return typeof error?.code === "string" && error.code.startsWith("CODEX_") ? error.code : "CODEX_RUNTIME_FAILED";
}

function runWorker({ workerFile, env, payload, signal, onStart, onThread, onProgress }) {
  return new Promise((resolve, rejectPromise) => {
    if (signal?.aborted) { rejectPromise(Object.assign(new Error(), { code: "CODEX_CANCELLED_BEFORE_START" })); return; }
    const child = fork(workerFile, [], { env, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let final, threadId, lastPhase = "worker_boot", updates = Promise.resolve(), stopping = false, closed = false, exited = false, killDone = Promise.resolve(false);
    let persistenceFailed = false, lastProbe = Date.now();
    child.once("exit", () => { exited = true; });
    const stop = () => {
      if (stopping || exited || closed || !Number.isSafeInteger(child.pid)) return;
      stopping = true;
      // PID is the still-owned worker, never supplied by an MCP caller.
      killDone = terminateProcessTree(child.pid).then(() => true, () => false);
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.on("message", message => {
      if (message.type === "thread" && /^[a-f0-9-]{36}$/.test(message.id || "")) {
        threadId = message.id;
        updates = updates.then(() => onThread(threadId, child.pid));
        updates.catch(stop);
      } else if (message.type === "progress") {
        lastPhase = sanitizeDiagnostic({ origin: "adapter", phase: message.phase, category: "unknown" }).phase;
        if (onProgress && Date.now() - lastProbe >= 5000) {
          lastProbe = Date.now();
          updates = updates.then(() => onProgress(child.pid));
          updates.catch(() => { persistenceFailed = true; stop(); });
        }
      } else if (message.type === "result") final = message;
    });
    child.on("error", () => {});
    child.once("close", async code => {
      closed = true;
      signal?.removeEventListener("abort", stop);
      let persisted = true;
      try { await updates; } catch { persisted = false; }
      persisted = persisted && !persistenceFailed;
      const terminated = stopping && await killDone;
      const completed = !stopping && persisted && code === 0 && final?.completed === true && !!threadId && !!final.answer;
      const diagnostic = sanitizeDiagnostic(final?.diagnostic) || (!completed ? sanitizeDiagnostic({
        origin: final ? "adapter" : "worker_exit", phase: final ? lastPhase : "worker_exit",
        category: final ? "incomplete_result" : "worker_exit", thread_started: !!threadId,
        worker_exit_code: code,
      }) : null);
      resolve({ ...final, diagnostic, completed, terminated, process_evidence_complete: persisted });
    });
    updates = updates.then(() => onStart(child.pid));
    updates.then(() => {
      if (closed || exited) return;
      if (signal?.aborted) stop();
      else child.send(payload, error => { if (error) stop(); });
    }).catch(() => { persistenceFailed = true; stop(); });
    if (signal?.aborted) stop();
  });
}
