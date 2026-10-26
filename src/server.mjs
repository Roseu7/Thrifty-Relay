import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  CODEX_MODEL_OPTIONS,
  MAX_CODEX_AGENTS,
  MIN_CODEX_AGENTS,
  QUOTA_LIMIT_ACTION_OPTIONS,
  REVIEW_POLICY_OPTIONS,
  UPPER_MODEL_OPTIONS,
  readSetupConfig,
} from "./config.mjs";
import { formatSettingsFallback, publicSettingsPayload, readSettings, updateSettings } from "./cli/settings.mjs";
import { getConfigPath, resolveLanguagePreference, translate } from "./i18n/index.mjs";
import { applyPatch } from "./mcp/patch.mjs";
import { admissionState, evaluateStepResolved, recordRefusal, tierForPolicy } from "./mcp/admission.mjs";
import { approvalDirectory, approvalForTask, bindingHash, consumeWindow, openWindow } from "./mcp/approval.mjs";
import {
  claimPending, closePending, createPending, expirePending, finishPending, PENDING_TTL_MS,
  readClaimed, readDecision, readPending, restorePending, scanPending, scratchRootChanged,
} from "./mcp/approval-pending.mjs";
import { pathsAdapter, platformName } from "./platform/index.mjs";
import { createTaskManager, MAX_INSPECT_WAIT_MS } from "./mcp/task-manager.mjs";
import { resolveScratchStep } from "./mcp/scratch.mjs";
import { runCodeMode } from "./mcp/code-mode.mjs";
import { skillsInstructions } from "./skills/catalog.mjs";
import { VERSION } from "./version.mjs";
import { sourceBuild } from "./source-build.mjs";

const TASK_DIR = pathsAdapter().taskDirectory({ env: process.env, home: os.homedir() });
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = getConfigPath();
// The configured area is the one place reads and writes can avoid a window; an installation
// that predates the setting still gets the OS default, but only a matching scratch_roots entry
// in the registration makes it approval-free.
const setupConfig = await readSetupConfig(CONFIG_FILE).catch(() => ({}));
const configuredTemp = process.env.THRIFTYRELAY_TEMP_WORKSPACE || setupConfig.tempWorkspace;
const SCRATCH_ROOT = typeof configuredTemp === "string" && pathsAdapter().isAbsolute(configuredTemp)
  ? configuredTemp
  : pathsAdapter().tempDirectory({ env: process.env, home: os.homedir() });
// Codex reads this at preflight time, and the POSIX runtime does not project setup settings into
// the environment. Publishing the resolved value here keeps cwd validation on the same root.
process.env.THRIFTYRELAY_TEMP_WORKSPACE ||= SCRATCH_ROOT;
const SETTINGS_RESOURCE_URI = "ui://thriftyrelay/settings-v2.html";
const SETTINGS_APP_FILE = path.join(APP_DIR, "src", "mcp", "settings-app.html");
const SETTINGS_APP_MIME = "text/html;profile=mcp-app";
const APPROVAL_RESOURCE_URI = "ui://thriftyrelay/approval-v1.html";
const APPROVAL_APP_FILE = path.join(APP_DIR, "src", "mcp", "approval-app.html");
const TR_ICONS = [
  { src: "data:image/png;base64," + (await fs.readFile(path.join(APP_DIR, "assets", "tr.png"))).toString("base64"),
    mimeType: "image/png", sizes: ["64x64"] },
  { src: "data:image/svg+xml;base64," + (await fs.readFile(path.join(APP_DIR, "assets", "tr.svg"))).toString("base64"),
    mimeType: "image/svg+xml", sizes: ["any"] },
];
await fs.mkdir(TASK_DIR, { recursive: true });
const START_BUILD = await sourceBuild(APP_DIR);

const childTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(APP_DIR, "node_modules", "@wonderwhy-er", "desktop-commander", "dist", "index.js")],
  // Desktop Commander sends usage telemetry unless told not to. Its own switch turns it off
  // without editing the user's Desktop Commander config; the rest is the SDK's default env.
  env: { ...getDefaultEnvironment(), DESKTOP_COMMANDER_DISABLE_TELEMETRY: "1" },
  stderr: "pipe",
});
childTransport.stderr?.resume();

const child = new Client(
  { name: "thriftyrelay", version: VERSION },
  { capabilities: {} },
);
await child.connect(childTransport);
const listed = await child.listTools();
const childTools = new Set(listed.tools.map((tool) => tool.name));

let codexAdapter;
function getCodexAdapter() {
  codexAdapter ||= import("./codex/adapter.mjs")
    .then(({ createCodexAdapter }) => createCodexAdapter({ dir: TASK_DIR, taskId }));
  return codexAdapter;
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function compactText(value) {
  return String(value ?? "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = Math.max(200, Math.floor(maxChars * 0.35));
  const tail = Math.max(200, maxChars - head - 80);
  return text.slice(0, head) +
    `\n[... ${text.length - head - tail} chars omitted ...]\n` +
    text.slice(-tail);
}
function taskId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
const TASK_ID_PATTERN = /^task_[a-z0-9]+_[a-z0-9]{6}$/;

function redactHistory(value) {
  return truncate(String(value ?? "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"), 12000);
}

async function callChild(name, args = {}) {
  if (!childTools.has(name)) {
    throw new Error(`Desktop Commander tool not available: ${name}`);
  }
  return child.callTool({ name, arguments: args });
}

function parsePid(text) {
  const match = text.match(/PID\s+(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function parseExitCode(text) {
  const matches = [...text.matchAll(/exit code\s+(-?\d+)/gi)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

function processDone(text) {
  return /Process completed with exit code\s+-?\d+/i.test(text);
}

function childResultFailed(name, result) {
  if (result?.isError) return true;
  const message = textOf(result).trim();
  return name === "edit_block" && /^(?:Expected \d+ occurrences but found|Search content not found|Error:|Failed to|Could not find|No matches found)/i.test(message);
}

function summarizeChildResult(name, result) {
  const text = compactText(textOf(result));
  if (childResultFailed(name, result)) {
    return `${name}: ERROR ${truncate(text.replace(/\s+/g, " "), 260)}`;
  }
  if (name === "edit_block") return "edit_block: OK";
  if (name === "write_file") return "write_file: OK";
  if (name === "read_file") {
    const match = text.match(/\[Reading ([^\]]+)\]/);
    return `read_file: OK${match ? ` (${match[1]})` : ""}`;
  }
  return `${name}: OK`;
}

async function runCommand(step, context = {}) {
  const timeoutMs = step.timeout_ms ?? 60000;
  const started = Date.now();
  if (context.signal?.aborted) {
    return { result: { content: [] }, summary: "run: CANCELLED", failed: true,
      status: context.reason?.() || "cancelled" };
  }
  const start = await callChild("start_process", {
    command: step.command,
    timeout_ms: Math.min(timeoutMs, context.async ? 1000 : 30000),
    ...(step.shell ? { shell: step.shell } : {}),
    origin: "llm",
  });
  const startText = compactText(textOf(start));
  if (start?.isError) return { result: start, summary: "run: ERROR (start failed)", failed: true, execution_unknown: true };
  // The first output read replays initial output; use startText only if no read arrives.
  let full = processDone(startText) ? startText : "";
  const pid = parsePid(startText);
  if (pid !== null && !processDone(startText)) await context.onPid?.(pid);
  const deadline = started + timeoutMs;
  let pollError = false;
  let interrupted = null;

  while (pid !== null && !processDone(full) && Date.now() < deadline) {
    if (context.signal?.aborted) {
      interrupted = context.reason?.() || "cancelled";
      break;
    }
    const remaining = Math.max(250, deadline - Date.now());
    const next = await callChild("read_process_output", {
      pid, timeout_ms: Math.min(5000, remaining), offset: 0, length: 100,
    });
    const nextText = compactText(textOf(next));
    if (nextText) full = truncate(full ? full + "\n" + nextText : nextText, 30000);
    if (next?.isError) { pollError = true; break; }
  }
  if (!processDone(full) && !interrupted && context.signal?.aborted) {
    interrupted = context.reason?.() || "cancelled";
  }
  if (!processDone(full) && !interrupted && Date.now() >= deadline) interrupted = "timed_out";

  if (interrupted && !processDone(full)) {
    let killStatus = "no PID available; process termination unconfirmed";
    if (pid !== null) {
      try {
        const killed = await callChild("force_terminate", { pid });
        const message = compactText(textOf(killed));
        killStatus = killed?.isError || /^Error:/i.test(message.trim())
          ? "termination unconfirmed: " + truncate(message, 160)
          : "termination requested";
      } catch (error) {
        killStatus = "termination unconfirmed: " + String(error);
      }
    }
    return {
      result: { content: [{ type: "text", text: full || startText }] },
      summary: "run: " + (interrupted === "timed_out" ? "TIMEOUT" : "CANCELLED") +
        " (PID " + (pid ?? "?") + "; " + killStatus + ")",
      failed: true,
      status: interrupted,
      execution_unknown: true,
    };
  }

  const exitCode = parseExitCode(full);
  const confirmed = processDone(full) && exitCode !== null && !pollError;
  return {
    result: { content: [{ type: "text", text: full || startText }] },
    summary: confirmed
      ? "run: " + (exitCode === 0 ? "PASS" : "FAIL(exit " + exitCode + ")")
      : "run: UNCONFIRMED" + (pid !== null ? " (PID " + pid + ")" : "") + "; inspect before retry",
    failed: !confirmed || exitCode !== 0,
    execution_unknown: !confirmed,
  };
}

async function runSearch(step, context = {}) {
  const maxResults = step.max_results ?? 30;
  const start = await callChild("start_search", {
    path: step.path,
    pattern: step.pattern,
    searchType: step.search_type ?? "content",
    ...(step.file_pattern ? { filePattern: step.file_pattern } : {}),
    ignoreCase: step.ignore_case ?? true,
    maxResults,
    includeHidden: step.include_hidden ?? true,
    contextLines: step.context_lines ?? 3,
    timeout_ms: step.timeout_ms ?? 15000,
    earlyTermination: false,
    literalSearch: step.literal_search ?? false,
    origin: "llm",
  });
  const startText = compactText(textOf(start));
  if (start?.isError) return { result: start, summary: "search: ERROR (start failed)", failed: true };
  const sessionMatch = startText.match(/session:\s*([A-Za-z0-9_-]+)/i);
  if (!sessionMatch) {
    return {
      result: start,
      summary: "search: ERROR (missing session id)",
      failed: true,
    };
  }

  const sessionId = sessionMatch[1];
  const deadline = Date.now() + (step.timeout_ms ?? 15000);
  let latest = startText;
  let searchFailed = false;
  while (!/Status:\s*COMPLETED/i.test(latest) && Date.now() < deadline) {
    if (context.signal?.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const page = await callChild("get_more_search_results", {
      sessionId,
      offset: 0,
      length: maxResults,
    });
    latest = compactText(textOf(page));
    if (page?.isError || /Status:\s*(?:FAILED|ERROR|CANCELLED)/i.test(latest)) {
      searchFailed = true;
      break;
    }
  }
  const interrupted = context.signal?.aborted;
  const completed = /Status:\s*COMPLETED/i.test(latest);
  if (!completed && !searchFailed) await callChild("stop_search", { sessionId }).catch(() => {});

  const count = latest.match(/Total results found:\s*(\d+)/i)?.[1]
    ?? latest.match(/Total results:\s*(\d+)/i)?.[1]
    ?? "?";
  return {
    result: { content: [{ type: "text", text: latest }] },
    summary: interrupted ? "search: CANCELLED" : completed ? `search: OK (${count} results)` : `search: ${searchFailed ? "ERROR" : "TIMEOUT"} (not complete)`,
    failed: interrupted || !completed || searchFailed,
    status: interrupted ? (context.reason?.() || "cancelled") : (!completed && !searchFailed ? "timed_out" : undefined),
  };
}

function approvalFailure(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

// The card describes the steps; it does not carry a second copy of them. Bodies stay in the
// stored args and are fetched only when the user expands one, so the pending record cannot grow
// into a duplicate of the operation.
function stepDisplayBody(step) {
  switch (step?.kind) {
    case "write": return step.content ?? "";
    case "edit": return "old:\n" + (step.old_string ?? "") + "\n\nnew:\n" + (step.new_string ?? "");
    case "run": return step.command ?? "";
    case "code": return step.code ?? "";
    case "codex": return step.prompt ?? "";
    case "patch":
      return (step.files ?? []).map(file =>
        "file: " + file.path + "\n" + (file.edits ?? []).map((edit, index) =>
          "#" + (index + 1) + "\n- " + edit.old_string + "\n+ " + edit.new_string).join("\n")
      ).join("\n\n");
    case "call": return JSON.stringify({ tool: step.tool, arguments: step.arguments ?? {} }, null, 2);
    default: return "";
  }
}

function detailKind(kind) {
  return {
    write: "content", edit: "edit", run: "command", code: "code",
    codex: "prompt", patch: "diff", call: "arguments",
  }[kind] ?? null;
}

function lineCount(value) {
  return typeof value === "string" && value ? value.split("\n").length : 0;
}

// A planned value is one the submission asked to place inside the task's scratch directory:
// relative, or spelled with the token. Absolute paths stay "as specified" even in a scratch
// task, because admission treats them as ordinary decisions.
function plannedValue(value) {
  return typeof value === "string" && value !== "" &&
    (value.includes("{{scratch}}") || !path.isAbsolute(value));
}

function stepDisplaySummary(step) {
  switch (step?.kind) {
    case "run": {
      const command = (step.command ?? "").replace(/\s+/g, " ").trim();
      return { text: command.length > 240 ? command.slice(0, 240) + "…" : command, truncated: command.length > 240 };
    }
    case "codex": {
      const prompt = step.prompt ?? "";
      return { text: prompt.length > 160 ? prompt.slice(0, 160) + "…" : prompt, truncated: prompt.length > 160 };
    }
    case "call": return { text: step.tool ?? "", truncated: false };
    case "search": return { text: step.pattern ?? "", truncated: false };
    default: return { text: "", truncated: false };
  }
}

function stepDisplayStats(step) {
  if (step?.kind === "patch") {
    return {
      files: Array.isArray(step.files) ? step.files.length : 0,
      edits: Array.isArray(step.files) ? step.files.reduce((total, file) => total + (file.edits?.length ?? 0), 0) : 0,
    };
  }
  if (step?.kind === "code") return { lines: lineCount(step.code) };
  if (step?.kind === "write") return { lines: lineCount(step.content) };
  return null;
}

// Display resolution is lexical and uses the root the request was made against. It is a
// prediction the user can check, not a claim that the write cannot follow a link: admission
// governs that separately, and a full-tier approval does not make every path inside.
function displaySteps(record) {
  const rawSteps = Array.isArray(record?.args?.steps) ? record.args.steps : [];
  const scratch = record?.args?.scratch === true;
  const base = scratch && typeof record.scratch_root === "string" && record.scratch_root
    ? path.join(record.scratch_root, record.task_id)
    : null;
  return rawSteps.map((raw, index) => {
    let shown = raw;
    if (base) {
      try { shown = resolveScratchStep(raw, base); } catch { /* display only; admission owns refusal */ }
    }
    const targets = [];
    const add = (key, value, source) => {
      if (typeof value !== "string" || !value) return;
      targets.push({ key, value, planned: scratch && plannedValue(source) });
    };
    add("path", shown.path, raw.path);
    add("path", shown.file_path, raw.file_path);
    add("cwd", shown.cwd, raw.cwd);
    if (Array.isArray(shown.files)) {
      shown.files.forEach((file, fileIndex) => add("path", file?.path, raw.files?.[fileIndex]?.path));
    }
    const summary = stepDisplaySummary(shown);
    return {
      index,
      kind: raw.kind,
      label: raw.label ?? null,
      summary: summary.text,
      summary_truncated: summary.truncated,
      stats: stepDisplayStats(raw),
      targets,
      detail_kind: detailKind(raw.kind),
      body_bytes: Buffer.byteLength(stepDisplayBody(shown), "utf8"),
    };
  });
}

function approvalItem(record) {
  const created = Date.parse(record.created_at);
  return {
    task_id: record.task_id,
    scratch: record.args?.scratch === true,
    stop_on_error: record.args?.stop_on_error !== false,
    stale: scratchRootChanged({ record, currentRoot: SCRATCH_ROOT, samePath: pathsAdapter().samePath }),
    expires_at: Number.isFinite(created) ? new Date(created + PENDING_TTL_MS).toISOString() : null,
    steps: displaySteps(record),
  };
}

function approvalCard(record, policy) {
  return {
    content: [{ type: "text", text:
      "APPROVAL_REQUIRED task=" + record.task_id + "\n" +
      "Call open_approval with task_id=" + record.task_id + " to show the card. Nothing runs until the user approves there; " +
      "the user may also decline it. Afterwards wait with remote_inspect task_id=" + record.task_id + "." }],
    structuredContent: {
      approval_required: true, binding: record.binding,
      max_minutes: policy?.full_access?.max_minutes ?? 0, ...approvalItem(record),
    },
    _meta: { ui: { resourceUri: APPROVAL_RESOURCE_URI } },
  };
}

async function taskRecordExists(taskIdValue) {
  if (typeof taskIdValue !== "string" || !TASK_ID_PATTERN.test(taskIdValue)) return false;
  try { await fs.access(path.join(TASK_DIR, taskIdValue + ".json")); return true; }
  catch { return false; }
}

// One resolver for the card, the list and inspect: task, then the decision (so a leftover
// claimed file cannot hide a completed decline), then the pending/claimed pair.
async function approvalOutcome(taskIdValue, { mutate = false } = {}) {
  const directory = approvalDirectory();
  if (await taskRecordExists(taskIdValue)) return { state: "started" };
  const decision = await readDecision({ directory, taskId: taskIdValue });
  if (decision) return { state: decision.outcome, decision };
  const [pending, claimed] = await Promise.all([
    readPending({ directory, taskId: taskIdValue }),
    readClaimed({ directory, taskId: taskIdValue }),
  ]);
  if (pending && claimed) return { state: "conflict" };
  if (pending) {
    const created = Date.parse(pending.created_at);
    if (Number.isFinite(created) && Date.now() - created < PENDING_TTL_MS) {
      return { state: "pending", record: pending };
    }
    if (!mutate) return { state: "expired", record: pending };
    const closed = await expirePending({ directory, taskId: taskIdValue });
    if (closed.state === "expired") return { state: "expired", record: pending };
    // Someone claimed it between the read and the expiry. Report what the store says now.
    return approvalOutcome(taskIdValue, { mutate: false });
  }
  if (claimed) return { state: "claimed", record: claimed };
  return { state: "missing" };
}

function approvalStateMessage(outcome, taskIdValue) {
  switch (outcome.state) {
    case "pending": {
      const created = Date.parse(outcome.record?.created_at);
      const remaining = Number.isFinite(created)
        ? Math.max(0, Math.ceil((created + PENDING_TTL_MS - Date.now()) / 60_000)) : 0;
      return "APPROVAL_PENDING: task " + taskIdValue + " (" + remaining + " min left). Nothing runs until the user " +
        "approves it in the card.";
    }
    case "claimed":
      return "APPROVAL_IN_PROGRESS: task " + taskIdValue + " is being processed, or its outcome could not be " +
        "confirmed. Do not approve or resubmit this id.";
    case "declined":
      return "APPROVAL_DECLINED: the user declined task " + taskIdValue + "; nothing ran and no window was spent.";
    case "expired":
      return "APPROVAL_EXPIRED: the approval for task " + taskIdValue + " expired before it was approved; nothing ran. " +
        "Ask for a new approval only if the work is still needed.";
    case "invalidated":
      return "APPROVAL_INVALIDATED: the temporary work area changed after task " + taskIdValue + " was submitted; " +
        "nothing ran. Submit the request again to receive a new approval.";
    case "started":
      return "APPROVAL_ALREADY_STARTED: task " + taskIdValue + " was already approved and started; use remote_inspect " +
        "without wait_ms to check it.";
    case "conflict":
      return "APPROVAL_STATE_CONFLICT: task " + taskIdValue + " has both a pending and a claimed record; nothing " +
        "runs. Do not approve or resubmit this id.";
    default:
      return null;
  }
}

// The one gate a submission passes before the task exists. It answers three ways: run as before
// (unregistered host, or the registration already permits the steps), refuse (a registration
// that cannot be honoured, or a mode that never grants full access), or hold the exact
// submission for the card. The decision is the same evaluateStep the per-step check uses, so
// the card is offered exactly when execution would be refused.
async function gateTask(args) {
  const state = await admissionState();
  if (state.status === "unregistered") return { admission: {} };
  if (state.status === "blocked") return { response: approvalFailure("ADMISSION_POLICY_UNAVAILABLE: " + state.code) };
  const { tier } = tierForPolicy({ policy: state.policy });
  if (tier === "full") return { admission: {} };
  // A scratch submission may use relative paths; classify them against the configured root so
  // the gate answers the same way the per-step check will. The escape check is strict here too:
  // such a step can never run, and holding it for approval would spend a window and then fail
  // before the task exists, leaving no id to inspect. The placeholder directory is enough
  // because any escape climbs past it by the same path whether the base is real or not.
  let steps = args.steps;
  if (args.scratch) {
    try {
      steps = args.steps.map(step => resolveScratchStep(step, path.join(SCRATCH_ROOT, "_gate_")));
    } catch (error) {
      return { response: approvalFailure("SCRATCH_PATH_ESCAPE: " + String(error?.detail ?? error?.code ?? error)) };
    }
  }
  let needsFull = false;
  for (const step of steps) {
    const decision = await evaluateStepResolved({
      step, policy: state.policy, tier: "standard", appDirectory: APP_DIR, home: os.homedir(),
    });
    if (!decision.allowed) { needsFull = true; break; }
  }
  if (!needsFull) return { admission: {} };
  if (state.policy.full_access?.mode !== "window") {
    return { response: approvalFailure("ADMISSION_TIER_REQUIRED: the registration does not permit full access") };
  }
  const id = taskId();
  const binding = bindingHash(args.steps);
  const record = await createPending({
    directory: approvalDirectory(), taskId: id, binding, args,
    scratchRoot: args.scratch ? SCRATCH_ROOT : null,
  });
  return { response: approvalCard(record, state.policy) };
}

// Health says whether permission is being enforced and at which tier, so an unregistered host
// is visible instead of looking protected.
async function enforcementStatus() {
  const state = await admissionState().catch(() => ({ status: "unavailable" }));
  if (state.status !== "registered") return state.status;
  const { tier, reason } = tierForPolicy({ policy: state.policy });
  return "policy:" + tier + ":" + reason;
}

// One admission decision before every step, including the nested steps of code mode: the
// execution path is the only place that sees all of them, so a tool that is added later
// cannot skip the decision by not calling it (design 2.1). A host that was never registered
// keeps its previous behaviour; enforcement begins with the registration.
async function stepAdmission(step, context = {}) {
  const state = await admissionState();
  if (state.status === "unregistered") return { allowed: true, enforcement: "unregistered" };
  if (state.status === "blocked") {
    return { allowed: false, code: "ADMISSION_POLICY_UNAVAILABLE", detail: state.code };
  }
  // The tier for a task comes from the window it spent, read from disk on every step: an
  // expiry or revocation during the run does not need the task to cooperate.
  const approval = context.task_id
    ? await approvalForTask({ directory: approvalDirectory(), taskId: context.task_id, policy: state.policy }).catch(() => null)
    : null;
  const { tier } = approval ? { tier: "full" } : tierForPolicy({ policy: state.policy });
  return evaluateStepResolved({
    step, policy: state.policy, tier, appDirectory: APP_DIR, home: os.homedir(),
    taskId: context.task_id ?? context.taskId ?? null,
  });
}

async function executeStep(step, context = {}) {
  const admission = await stepAdmission(step, context);
  if (!admission.allowed) {
    // The refusal is recorded, not thrown: the task records one failed step with a code the
    // caller can act on, and the loop continues or stops according to stop_on_error.
    await recordRefusal({
      code: admission.code, detail: admission.detail, kind: step.kind,
      taskId: context.taskId ?? context.task?.id ?? null,
    }).catch(() => {});
    return {
      result: { isError: true, content: [{ type: "text", text: admission.code + (admission.detail ? ": " + admission.detail : "") }] },
      summary: "admission: " + admission.code,
      failed: true,
      status: "denied",
    };
  }
  switch (step.kind) {
    case "codex":
      return (await getCodexAdapter()).execute(step, { ...context, sandbox: admission.sandbox });
    case "read": {
      const result = await callChild("read_file", {
        path: step.path,
        offset: step.offset ?? 0,
        length: step.length ?? 100,
        origin: "llm",
      });
      return { result, summary: summarizeChildResult("read_file", result), failed: !!result?.isError };
    }
    case "edit": {
      const result = await callChild("edit_block", {
        file_path: step.file_path,
        old_string: step.old_string,
        new_string: step.new_string,
        expected_replacements: step.expected_replacements ?? 1,
        origin: "llm",
      });
      return { result, summary: summarizeChildResult("edit_block", result), failed: childResultFailed("edit_block", result) };
    }
    case "write": {
      const result = await callChild("write_file", {
        path: step.path,
        content: step.content,
        mode: step.mode ?? "rewrite",
        origin: "llm",
      });
      return { result, summary: summarizeChildResult("write_file", result), failed: !!result?.isError };
    }
    case "run":
      return runCommand(step, context);
    case "patch": {
      const summary = await applyPatch(step.files);
      return { result: { content: [{ type: "text", text: summary }] }, summary, failed: false };
    }
    case "search":
      return runSearch(step, context);
    case "code":
      return runCodeMode(step.code, async (request, nestedContext) => {
        const parsed = StepSchema.safeParse(request);
        if (!parsed.success || ["code", "codex"].includes(parsed.data.kind)) {
          throw new Error("Invalid Code Mode operation: " +
            (parsed.success ? "nested code/codex is not allowed" : parsed.error.issues[0]?.message));
        }
        const executed = await executeStep(parsed.data, nestedContext);
        return { ...executed, output: compactText(textOf(executed.result)) };
      }, context);
    case "call": {
      const result = await callChild(step.tool, step.arguments ?? {});
      return { result, summary: summarizeChildResult(step.tool, result), failed: !!result?.isError, execution_unknown: !!result?.isError };
    }
    default:
      throw new Error(`Unknown step kind: ${step.kind}`);
  }
}

const ReadStep = z.object({
  kind: z.literal("read"),
  path: z.string(),
  offset: z.number().int().optional(),
  length: z.number().int().min(1).max(1000).optional(),
  expose: z.boolean().default(true).describe(
    "Return the content to you. Exposed images come back as MCP image content, up to 8 MiB and 4 images per task."),
  label: z.string().optional(),
});
const EditStep = z.object({
  kind: z.literal("edit"),
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  expected_replacements: z.number().int().min(0).optional(),
  expose: z.boolean().default(false),
  label: z.string().optional(),
});
const WriteStep = z.object({
  kind: z.literal("write"),
  path: z.string(),
  content: z.string(),
  mode: z.enum(["rewrite", "append"]).default("rewrite"),
  expose: z.boolean().default(false),
  label: z.string().optional(),
});

const RunStep = z.object({
  kind: z.literal("run"),
  command: z.string().describe(
    "Starts in the server's working directory, not the workspace, so change directory inside the command. The default shell is powershell.exe on Windows (Set-Location -LiteralPath 'C:\\work\\app'; npm test) and $SHELL or /bin/sh elsewhere."),
  shell: z.string().optional().describe("A shell to use instead of the default."),
  timeout_ms: z.number().int().min(1000).max(3600000).optional(),
  expose: z.boolean().default(false),
  label: z.string().optional(),
});
const SearchStep = z.object({
  kind: z.literal("search"),
  path: z.string(),
  pattern: z.string(),
  search_type: z.enum(["files", "content"]).default("content"),
  file_pattern: z.string().optional(),
  ignore_case: z.boolean().default(true),
  include_hidden: z.boolean().default(true),
  context_lines: z.number().int().min(0).max(20).default(3),
  max_results: z.number().int().min(1).max(100).default(30),
  timeout_ms: z.number().int().min(1000).max(60000).default(15000),
  literal_search: z.boolean().default(false),
  expose: z.boolean().default(true),
  label: z.string().optional(),
});
const PatchEdit = z.object({
  old_string: z.string().min(1),
  new_string: z.string(),
  expected_replacements: z.number().int().min(1).default(1),
}).strict();
const PatchStep = z.object({
  kind: z.literal("patch").describe("Edits several files; every file is validated before any edit is applied."),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    edits: z.array(PatchEdit).min(1),
  }).strict()).min(1).max(30),
  expose: z.boolean().default(false),
  label: z.string().optional(),
});
const CallStep = z.object({
  kind: z.literal("call"),
  tool: z.string().describe("Any Desktop Commander tool, for work the other step kinds do not cover."),
  arguments: z.record(z.string(), z.unknown()).default({}),
  expose: z.boolean().default(false),
  label: z.string().optional(),
});
const CodeStep = z.object({
  kind: z.literal("code"),
  code: z.string().min(1).max(64000).describe(
    "Bounded JavaScript (QuickJS/WASM) for several reads or transformations in one step: await tools.read({path}), tools.run({command}), tools.step({kind,...}), Promise.all([...]), and text(value) for the final output. No Node APIs. Limits: 60 s wall, 2 s CPU, 32 MiB, 30 operations, 4 concurrent."),
  expose: z.boolean().default(true),
  label: z.string().optional(),
});
const CodexStep = z.object({
  kind: z.literal("codex"),
  prompt: z.string().min(1).max(32000),
  cwd: z.string().min(1).describe(
    "The configured Codex workspace, as an absolute path. It does not limit which paths other step kinds can use."),
  request_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/).describe(
    "Unique per task intent. Reuse it only to resend the identical request, such as after quota approval. Never resend a write with an unknown outcome under a new ID; recovery is local-only through thriftyrelay recover."),
  quota_warning_approved: z.boolean().optional().describe(
    "Set true only after the user explicitly approves a CODEX_QUOTA_APPROVAL_REQUIRED warning, as the server instructions describe."),
  quota_approval_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional().describe(
    "Token issued with a quota warning. Send it only with the exact original request_id and unchanged task intent; do not include it in prompts, reviews, summaries, or logs."),
  permissions: z.literal("full-access").describe(
    "Required acknowledgement that Codex acts with the user's account. It does not choose or widen the sandbox: the local registration decides read-only, workspace-write, or full access. If the result reports a narrower sandbox, tell the user instead of retrying."),
  conversation_id: z.string().regex(/^cx_[a-f0-9]{32}$/).optional().describe(
    "Continue an earlier Codex conversation. Without model_role it keeps that conversation's model and effort."),
  model_role: z.enum(["base", "upper"]).optional().describe(
    "base for ordinary work, upper for justified escalation; the saved settings choose the model and effort. A new conversation without it uses base."),
  expected_files: z.array(z.string().min(1).max(240)).max(100).optional().describe(
    "cwd-relative files you expect Codex to change. It does not restrict writes; other changes are only marked unexpected in result.review."),
  write_scopes: z.union([z.literal("global"), z.array(z.object({
    kind: z.enum(["file", "directory"]), path: z.string().min(1).max(240),
  }).strict()).min(1).max(100)]).optional().describe(
    "Omit for normal use, so one Codex writer runs at a time. When given, it declares every write relative to cwd for admission and is not an OS sandbox; shared configs, installs, and git operations need global. A conflict fails without starting a worker."),
  task_type: z.enum(["question", "research", "code"]).default("question").describe(
    "code adds a file-change review in result.review. Use question or research when Codex should only investigate, and say so in the prompt."),
  readOnly: z.boolean().default(false).describe("true is rejected, because a request cannot choose the sandbox."),
  expose: z.boolean().default(false),
  label: z.string().optional(),
}).strict();
const StepSchema = z.discriminatedUnion("kind", [
  ReadStep, EditStep, WriteStep, RunStep, SearchStep, PatchStep, CallStep, CodeStep, CodexStep,
]);

const taskManager = createTaskManager({
  dir: TASK_DIR, executeStep, textOf, compactText, truncate, redactHistory, taskId,
  idPattern: TASK_ID_PATTERN, scratchRoot: SCRATCH_ROOT,
  explainMissing: async id => approvalStateMessage(await approvalOutcome(id), id),
});

const server = new McpServer({
  name: "ThriftyRelay",
  version: VERSION,
  icons: TR_ICONS,
}, {
  // Bound collection validation before requests can reach Commander's unpatched Zod 3.
  maxToolInputElements: 10_000,
  instructions: "ThriftyRelay lets ChatGPT work on the user's PC.\n" +
    "Do direct work yourself with remote_task steps: read or search to look at files, edit, write, or patch for focused changes, and run for commands; then check the result with read or run.\n" +
    "Delegate to Codex with one async codex step when the work needs investigation or changes across several files. Then call remote_inspect with only task_id to wait for its final result; when it is still running, wait again on the same ID without resubmitting or commenting on each wait. Review the actual files and command outcomes before you report completion.\n" +
    "Codex work uses the base model. Set model_role=upper only for a specific unresolved problem, repeated failures, or the user's request, never automatically; the user's settings decide which model and effort each role uses.\n" +
    "If remote_task returns CODEX_QUOTA_APPROVAL_REQUIRED, show the user both 5h and 1w remaining percentages, thresholds, and reset times, then ask for explicit consent; never approve automatically. Only after consent, resend the exact same request_id and unchanged task intent with quota_warning_approved=true and the issued quota_approval_token. If a quota is blocked or unavailable, do not retry automatically.\n" +
    "Read the focused workflow once via remote_task read: " + path.join(APP_DIR, "docs/en/orchestration.md") + "\n" + await skillsInstructions(),
});

const SettingsUpdateSchema = z.object({
  language: z.enum(["ja", "en"]).optional(),
  baseModel: z.enum([...CODEX_MODEL_OPTIONS]).optional(),
  upperModel: z.enum([...UPPER_MODEL_OPTIONS]).optional(),
  maxCodexAgents: z.number().int().min(MIN_CODEX_AGENTS).max(MAX_CODEX_AGENTS).optional(),
  reviewPolicy: z.enum([...REVIEW_POLICY_OPTIONS]).optional(),
  fiveHourLimitPercent: z.number().int().min(0).max(100).optional(),
  weeklyLimitPercent: z.number().int().min(0).max(100).optional(),
  fiveHourLimitAction: z.enum([...QUOTA_LIMIT_ACTION_OPTIONS]).optional(),
  weeklyLimitAction: z.enum([...QUOTA_LIMIT_ACTION_OPTIONS]).optional(),
}).strict().refine(value => Object.keys(value).length > 0);

async function settingsContext() {
  const configFile = getConfigPath();
  const preference = await resolveLanguagePreference({ configFile });
  return { configFile, language: preference.language };
}

function settingsResponse(settings, language) {
  return {
    content: [{ type: "text", text: formatSettingsFallback(settings, language) }],
    structuredContent: { ok: true, ...publicSettingsPayload(settings, language) },
  };
}

function settingsFailure(error, language) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : "CONFIG_UNAVAILABLE";
  const key = code === "CONFIG_INVALID" || code === "CONFIG_SECRET_FIELD_FORBIDDEN"
    ? "settings.error.configInvalid"
    : code === "SETTINGS_VALUE_INVALID" ? "settings.error.valueInvalid"
      : "settings.error.configUnavailable";
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${translate(language, key)}` }],
  };
}

server.registerResource("settings-app", SETTINGS_RESOURCE_URI, {
  title: "ThriftyRelay settings UI",
  description: "Settings interface loaded only by the explicit open_settings tool.",
  mimeType: SETTINGS_APP_MIME,
}, async () => ({
  contents: [{
    uri: SETTINGS_RESOURCE_URI,
    mimeType: SETTINGS_APP_MIME,
    text: await fs.readFile(SETTINGS_APP_FILE, "utf8"),
    _meta: { "openai/ui": { availableDisplayModes: ["inline"] } },
  }],
}));

server.registerResource("approval-app", APPROVAL_RESOURCE_URI, {
  title: "ThriftyRelay approval card",
  description: "Approval card loaded only by the explicit open_approval tool.",
  mimeType: SETTINGS_APP_MIME,
}, async () => ({
  contents: [{
    uri: APPROVAL_RESOURCE_URI,
    mimeType: SETTINGS_APP_MIME,
    text: await fs.readFile(APPROVAL_APP_FILE, "utf8"),
    _meta: { "openai/ui": { availableDisplayModes: ["inline"] } },
  }],
}));

const toolDefinitions = new Map();
function registerTool(name, definition, handler) {
  const registered = server.registerTool(name, definition, handler);
  toolDefinitions.set(name, { definition, registered });
}

registerTool("health", {
  icons: TR_ICONS,
  title: "Remote Health",
  description: "Confirm this local MCP is reachable. Returns only brief connection status.",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => ({
  content: [{ type: "text", text: `ThriftyRelay ${VERSION}: OK; ${platformName()}; file/shell tools available (${childTools.size} internal tools); ` +
    `build=${START_BUILD}; source=${await sourceBuild(APP_DIR) === START_BUILD ? "current" : "changed-restart-required"}; ` +
    `codex=${process.env.THRIFTYRELAY_CODEX_WORKSPACE ? "target-configured" : "disabled"}; writers=${await taskManager.coordinationEnabled() ? "coordinated" : "legacy"}; ` +
    `scratch=${SCRATCH_ROOT ? "configured" : "disabled"}; enforcement=${await enforcementStatus()}` }],
}));

registerTool("remote_task", {
  icons: TR_ICONS,
  title: "Run Remote Task",
  description:
    "Run work on the user's PC. Steps run in order in one call; batch related work to keep tool cards few.\n" +
    "Do direct work yourself: read or search to look at files, edit, write, or patch for focused changes, run for commands, code for several reads at once, and call for any other Desktop Commander tool.\n" +
    "Use one codex step for investigation or changes across several files. It needs execution=async; then call remote_inspect with only its task_id to wait for the answer, review, and usage.\n" +
    "A step cannot see an earlier step's result in the same call. When a file's content decides the next step, read it in one call and act in the next.\n" +
    "execution=sync waits for the steps; execution=async returns a task ID. Use async for codex and for commands that may run longer than about a minute.\n" +
    "When an administrator has registered an admission policy, run, call, and code steps, and paths outside the workspace or marked sensitive, need the user's approval: remote_task answers APPROVAL_REQUIRED with a task_id, then call open_approval and wait with remote_inspect.\n" +
    "Each field's description covers the rest, including quota approval and request_id reuse.\n" +
    "For relevant tasks, use the Codex Skills catalog from MCP instructions and read only selected SKILL.md files. " +
    "If the catalog is not visible, use a run step with: node " + path.join(APP_DIR, "src", "skills", "catalog.mjs") +
    "; discover once per relevant task, not for unrelated chat.",
  inputSchema: z.object({
    steps: z.array(StepSchema).min(1).max(30),
    stop_on_error: z.boolean().default(true),
    max_exposed_chars: z.number().int().min(1000).max(30000).default(3000),
    execution: z.enum(["sync", "async"]).default("sync"),
    task_timeout_ms: z.number().int().min(1000).max(14400000).default(1800000),
    scratch: z.boolean().default(false).describe(
      "Create a per-task temporary directory under the configured work area. Relative paths and the {{scratch}} token resolve there; absolute paths still pass admission. This does not change run/call/code or Codex permissions, and Codex steps reject it: name an absolute cwd instead."),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
}, async (args) => {
  if (args.steps.some(step => !["read", "search"].includes(step.kind)) && await sourceBuild(APP_DIR) !== START_BUILD) {
    return { isError: true, content: [{ type: "text", text: "REMOTE_SOURCE_CHANGED_RESTART_REQUIRED" }] };
  }
  if (args.steps.some(step => step.kind === "codex")) {
    if (args.steps.length !== 1 || args.execution !== "async") {
      return { isError: true, content: [{ type: "text", text: "CODEX_REQUIRES_ONE_ASYNC_STEP" }] };
    }
    return (await getCodexAdapter()).submit(args, taskManager.run);
  }
  const gate = await gateTask(args);
  if (gate.response) return gate.response;
  return taskManager.run(args, gate.admission);
});

registerTool("open_approval", {
  icons: TR_ICONS,
  title: "Open Approval Card",
  description:
    "Show the approval card for a pending task. Use only when remote_task answered APPROVAL_REQUIRED with a task id; " +
    "never proactively. Nothing executes from this call; the user approves in the card.",
  inputSchema: z.object({ task_id: z.string().regex(TASK_ID_PATTERN) }).strict(),
  _meta: {
    ui: { resourceUri: APPROVAL_RESOURCE_URI },
    "openai/outputTemplate": APPROVAL_RESOURCE_URI,
    "ui/resourceUri": APPROVAL_RESOURCE_URI,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ task_id }) => {
  const outcome = await approvalOutcome(task_id, { mutate: true });
  if (outcome.state === "pending") {
    const state = await admissionState();
    return approvalCard(outcome.record, state.status === "registered" ? state.policy : null);
  }
  return approvalFailure(approvalStateMessage(outcome, task_id) ?? "APPROVAL_WINDOW_NOT_FOUND: " + task_id);
});

registerTool("pending_approvals", {
  icons: TR_ICONS,
  title: "Pending Approvals",
  description: "Internal approval card data source. With task_id it returns that submission or its terminal state; " +
    "without it, the current pending list.",
  inputSchema: z.object({ task_id: z.string().regex(TASK_ID_PATTERN).optional() }).strict(),
  _meta: { ui: { visibility: ["app"] } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ task_id } = {}) => {
  const state = await admissionState();
  const maxMinutes = state.status === "registered" ? state.policy.full_access?.max_minutes ?? 0 : 0;
  let language = "en";
  try { language = (await settingsContext()).language; } catch {}
  const directory = approvalDirectory();
  if (task_id) {
    const outcome = await approvalOutcome(task_id, { mutate: true });
    return {
      content: [{ type: "text", text: outcome.state === "pending" ? "1 pending approval" : "Approval state: " + outcome.state }],
      structuredContent: {
        language, max_minutes: maxMinutes, state: outcome.state,
        ...(outcome.state === "pending" ? { item: approvalItem(outcome.record) } : {}),
      },
    };
  }
  const { items, expired } = await scanPending({ directory });
  for (const entry of expired) await expirePending({ directory, taskId: entry.task_id });
  return {
    content: [{ type: "text", text: items.length + " pending approval(s)" }],
    structuredContent: {
      language, max_minutes: maxMinutes,
      items: items.map(record => approvalItem(record)),
    },
  };
});

registerTool("approve_task", {
  icons: TR_ICONS,
  title: "Approve Task",
  description:
    "Internal approval card action. Spends one window for exactly the submission the card displayed " +
    "and starts it asynchronously; the task id stays the one the card was opened with.",
  inputSchema: z.object({ task_id: z.string().regex(TASK_ID_PATTERN), minutes: z.number().int().min(1).max(240) }),
  _meta: { ui: { visibility: ["app"] } },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ task_id, minutes }) => {
  const state = await admissionState();
  if (state.status !== "registered") return approvalFailure("ADMISSION_POLICY_UNAVAILABLE: " + state.status);
  const directory = approvalDirectory();
  const initial = await approvalOutcome(task_id);
  if (initial.state !== "pending" && initial.state !== "expired") {
    return approvalFailure(approvalStateMessage(initial, task_id) ?? "APPROVAL_WINDOW_NOT_FOUND: " + task_id);
  }
  // Claim exactly once. Everything below either proceeds with this record or closes it; no
  // helper is allowed to claim the same id again.
  const claimed = await claimPending({ directory, taskId: task_id });
  if (claimed.state === "missing" || claimed.state === "conflict") {
    const outcome = await approvalOutcome(task_id);
    return approvalFailure(approvalStateMessage(outcome, task_id) ?? "APPROVAL_WINDOW_NOT_FOUND: " + task_id);
  }
  if (claimed.state === "invalid") {
    await closePending({ directory, taskId: task_id, outcome: "expired" });
    return approvalFailure("APPROVAL_EXPIRED: task " + task_id + " could not be read; nothing ran.");
  }
  if (claimed.state === "expired") {
    const closed = await closePending({ directory, taskId: task_id, record: claimed.record, outcome: "expired" });
    return approvalFailure("APPROVAL_EXPIRED: task " + task_id + " expired before it was approved; nothing ran." +
      (closed.ok ? "" : " The decision record could not be saved."));
  }
  const pending = claimed.record;
  // The root a scratch request was planned against is part of what the user saw. A restart that
  // changes it makes the plan point somewhere else, so it is closed instead of executed.
  if (scratchRootChanged({ record: pending, currentRoot: SCRATCH_ROOT, samePath: pathsAdapter().samePath })) {
    await closePending({ directory, taskId: task_id, record: pending, outcome: "invalidated" });
    return approvalFailure("APPROVAL_INVALIDATED: the temporary work area changed after task " + task_id +
      " was submitted; nothing ran. Submit the request again.");
  }
  try {
    // Open and spend in one action: the run starts immediately, and a window that was never
    // consumed could be spent by a different call later.
    await openWindow({ directory, policy: state.policy, minutes, task: { id: task_id }, binding: pending.binding });
  } catch (error) {
    await restorePending({ directory, taskId: task_id }).catch(() => {});
    return approvalFailure(String(error?.code ?? error));
  }
  try {
    await consumeWindow({ directory, taskId: task_id, binding: pending.binding, policy: state.policy });
  } catch (error) {
    // A window has already been opened and counted. Keep the claim when its consumption
    // cannot be confirmed rather than offering the same operation for another approval.
    return approvalFailure(String(error?.code ?? error));
  }
  let started;
  try {
    // Always asynchronous: the card cannot wait for a long task, and the caller already has
    // the task id to inspect.
    started = await taskManager.run({ ...pending.args, execution: "async" }, { id: task_id });
    if (started?.isError) return approvalFailure("TASK_START_FAILED: " + (started.content?.[0]?.text ?? "unknown error"));
    await finishPending({ directory, taskId: task_id }).catch(() => {});
  } catch (error) {
    return approvalFailure("TASK_START_FAILED: " + String(error?.message ?? error));
  }
  const detail = started?.content?.[0]?.text ?? "started";
  return {
    content: [{ type: "text", text: "Task " + task_id + ": approved and started (async). " + detail }],
    structuredContent: { task_id, approved: true, detail },
  };
});

registerTool("decline_task", {
  icons: TR_ICONS,
  title: "Decline Task",
  description:
    "Internal approval card action. Ends the submission without running it and without spending a window. " +
    "The task id is kept in the approval record the same way a decline is inspected afterwards.",
  inputSchema: z.object({ task_id: z.string().regex(TASK_ID_PATTERN) }).strict(),
  _meta: { ui: { visibility: ["app"] } },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ task_id }) => {
  const directory = approvalDirectory();
  const initial = await approvalOutcome(task_id);
  if (initial.state !== "pending" && initial.state !== "expired") {
    return approvalFailure(approvalStateMessage(initial, task_id) ?? "APPROVAL_WINDOW_NOT_FOUND: " + task_id);
  }
  const claimed = await claimPending({ directory, taskId: task_id });
  if (claimed.state === "missing" || claimed.state === "conflict") {
    const outcome = await approvalOutcome(task_id);
    return approvalFailure(approvalStateMessage(outcome, task_id) ?? "APPROVAL_WINDOW_NOT_FOUND: " + task_id);
  }
  if (claimed.state === "invalid" || claimed.state === "expired") {
    await closePending({ directory, taskId: task_id, record: claimed.record, outcome: "expired" });
    return approvalFailure("APPROVAL_EXPIRED: task " + task_id + " expired before it was declined; nothing ran.");
  }
  // Declining never executes, so it stays the user's decision even when the request is stale:
  // the terminal reason is "declined", not "invalidated".
  const closed = await closePending({ directory, taskId: task_id, record: claimed.record, outcome: "declined" });
  if (!closed.ok) {
    return approvalFailure("APPROVAL_CLOSE_FAILED: task " + task_id + " will not run, but the decline could not " +
      "be recorded (" + closed.error + "). Do not approve it again.");
  }
  return {
    content: [{ type: "text", text: "Task " + task_id + ": declined. Nothing ran; no window was spent." }],
    structuredContent: { task_id, declined: true },
  };
});

registerTool("approval_step", {
  icons: TR_ICONS,
  title: "Approval Step Detail",
  description: "Internal approval card detail source. Returns one step body, capped for display.",
  inputSchema: z.object({ task_id: z.string().regex(TASK_ID_PATTERN), index: z.number().int().min(0) }).strict(),
  _meta: { ui: { visibility: ["app"] } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ task_id, index }) => {
  const outcome = await approvalOutcome(task_id);
  if (outcome.state !== "pending") {
    return approvalFailure(approvalStateMessage(outcome, task_id) ?? "APPROVAL_WINDOW_NOT_FOUND: " + task_id);
  }
  const record = outcome.record;
  const raw = record.args?.steps?.[index];
  if (!raw) return approvalFailure("APPROVAL_STEP_NOT_FOUND: " + index);
  let shown = raw;
  if (record.args?.scratch === true && typeof record.scratch_root === "string" && record.scratch_root) {
    try { shown = resolveScratchStep(raw, path.join(record.scratch_root, record.task_id)); } catch { /* keep raw */ }
  }
  const body = stepDisplayBody(shown);
  const total = Buffer.byteLength(body, "utf8");
  let totalChars = 0;
  for (const character of body) totalChars += 1;
  const truncated = total > 8192;
  const text = truncated ? new TextDecoder().decode(Buffer.from(body).subarray(0, 8192), { stream: true }) : body;
  return {
    content: [{ type: "text", text: text || "(empty)" }],
    structuredContent: { task_id, index, body: text, truncated, total_chars: totalChars, total_bytes: total },
  };
});

registerTool("remote_inspect", {
  icons: TR_ICONS,
  title: "Wait for Remote Task",
  description:
    "After submitting async work, call with task_id only. Waits up to 120s and returns immediately on completion. " +
    "Finished Codex tasks include answer/review/usage; do not fetch them again. " +
    "If still running, call again with the same ID without progress polling or repeated commentary. " +
    "wait_ms=0 is an immediate diagnostic snapshot. step_index retrieves specific stored output. " +
    "Exposed read/call images return as MCP image content; text character limits apply only to text, with image limits of 8 MiB/4 images per task. " +
    "action=cancel requests task cancellation immediately; ending a wait never cancels the task. Never resubmit unknown writes.",
  inputSchema: z.object({
    task_id: z.string(),
    wait_ms: z.number().int().min(0).max(MAX_INSPECT_WAIT_MS).default(MAX_INSPECT_WAIT_MS),
    step_index: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(500).max(30000).default(10000),
    action: z.enum(["inspect", "cancel"]).default("inspect"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
}, async (args, extra) => taskManager.inspect(args, { signal: extra.signal }));

registerTool("open_settings", {
  icons: TR_ICONS,
  title: "Open Settings",
  description:
    "Only use when user explicitly asks to open/view settings UI. Never call proactively. " +
    "Returns all nine safe settings and opens the optional MCP Apps view when the host supports it. " +
    "The view saves language, model preferences, maximum concurrent Codex agents, review policy, and the four quota threshold/action settings.",
  inputSchema: z.object({}).strict(),
  _meta: {
    ui: { resourceUri: SETTINGS_RESOURCE_URI },
    "openai/outputTemplate": SETTINGS_RESOURCE_URI,
    "ui/resourceUri": SETTINGS_RESOURCE_URI,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => {
  const { configFile, language } = await settingsContext();
  try {
    const settings = await readSettings({ configFile, language });
    return settingsResponse(settings, language);
  } catch (error) {
    return settingsFailure(error, language);
  }
});

registerTool("settings_update", {
  icons: TR_ICONS,
  title: "Save Settings",
  description: "Internal settings form submission. Accepts only the nine user-facing settings fields, including independent 5h and 1w quota thresholds and warn/block actions.",
  inputSchema: SettingsUpdateSchema,
  _meta: { ui: { visibility: ["app"] } },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async patch => {
  const { configFile, language } = await settingsContext();
  try {
    const settings = await updateSettings(patch, { configFile, language });
    return settingsResponse(settings, settings.language);
  } catch (error) {
    return settingsFailure(error, language);
  }
});

// SDK 1.31's high-level registerTool drops icons. Use the public low-level
// list handler, retaining the exact registered schemas, visibility and annotations.
server.server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [...toolDefinitions].filter(([, entry]) => entry.registered.enabled).map(([name, { definition }]) => ({
    ...definition, name, inputSchema: z.toJSONSchema(definition.inputSchema, { target: "draft-7", io: "input" }),
    execution: { taskSupport: "forbidden" },
  })),
}));

const transport = new StdioServerTransport();
await server.connect(transport);
