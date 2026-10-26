import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { psLiteral } from "./powershell.mjs";

const execFileAsync = promisify(execFile);

function platformError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

// The Schedule.Service COM API is queried instead of schtasks.exe because the tool's output
// is localized: a Japanese host prints its states in Japanese, and a parser that looks for
// "Ready" would report an unknown state there. The COM property values are numbers, so the
// mapping below is the same in every locale.
//
// A name is embedded in the script, so only a bounded set of plain strings is accepted, and
// each is escaped rather than filtered: the product's names are constants, and a caller that
// could pass anything would be able to run a different query.

function safeNames(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const unique = [...new Set(names)];
  if (unique.length !== names.length) return null;
  if (unique.some(name => typeof name !== "string" || name.length === 0 || name.length > 128)) return null;
  return unique;
}

export function startupQueryScript(names) {
  const safe = safeNames(names);
  if (!safe) throw platformError("STARTUP_QUERY_NAMES_INVALID");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$taskNames = @(" + safe.map(psLiteral).join(",") + ")",
    "$scheduler = New-Object -ComObject 'Schedule.Service'",
    "$scheduler.Connect()",
    "$taskFolder = $scheduler.GetFolder('\\')",
    "$tasks = @(foreach ($registeredTask in $taskFolder.GetTasks(1)) {",
    "  if ($taskNames -notcontains [string]$registeredTask.Name) { continue }",
    "  $taskState = switch ([int]$registeredTask.State) { 3 { 'Ready' } 4 { 'Running' } default { 'Unknown' } }",
    "  $actions = @($registeredTask.Definition.Actions)",
    "  [pscustomobject]@{ name = [string]$registeredTask.Name; path = '\\'; state = $taskState; actionCount = $actions.Count; actionValid = ($actions.Count -eq 1) }",
    "})",
    "[pscustomobject]@{ tasks = $tasks } | ConvertTo-Json -Depth 3 -Compress",
  ].join("\n");
}

// No locale-dependent behaviour and no elevation: reading the definition is what the remote
// side is allowed to do, while changing it stays a local elevated step (design 2.10).
async function runPowerShell(script) {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
  return stdout;
}

// The answer is either a definition or a failure: a half-parsed one would let the caller act
// on something the host never said.
export async function readStartupDefinitions({ names, run = runPowerShell } = {}) {
  const safe = safeNames(names);
  if (!safe) throw platformError("STARTUP_QUERY_NAMES_INVALID");

  let output;
  try {
    output = await run(startupQueryScript(safe));
  } catch {
    throw platformError("STARTUP_QUERY_FAILED");
  }

  try {
    const parsed = JSON.parse(String(output).trim());
    const raw = parsed?.tasks;
    const rawTasks = raw == null ? [] : Array.isArray(raw) ? raw : typeof raw === "object" ? [raw] : null;
    if (!rawTasks || rawTasks.length > safe.length) throw new Error();
    const definitions = rawTasks.map(task => {
      if (!safe.includes(task?.name) || typeof task.path !== "string" ||
          !["Ready", "Running", "Unknown"].includes(task.state) ||
          !Number.isSafeInteger(task.actionCount) || typeof task.actionValid !== "boolean") throw new Error();
      return {
        count: 1,
        name: task.name,
        path: task.path,
        state: task.state,
        actionCount: task.actionCount,
        actionValid: task.actionValid,
      };
    });
    if (new Set(definitions.map(definition => definition.name)).size !== definitions.length) throw new Error();
    return definitions;
  } catch {
    throw platformError("STARTUP_QUERY_FAILED");
  }
}
