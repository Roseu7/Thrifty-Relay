import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function platformError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail) error.detail = detail;
  return error;
}

export function normalizeExecutablePath(value) {
  const text = String(value ?? "");
  if (!text) return "";
  return path.win32.normalize(text).replaceAll("/", "\\").toLowerCase();
}

// Deliberately excludes command lines and environment values from evidence.
export async function probeProcesses(ids, descendants = false) {
  const selected = [...new Set(ids)];
  const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); $selected=@(${selected.join(",")}); ` +
    (descendants ? "for($depth=0;$depth -lt 256;$depth++){ $more=@($all | Where-Object {$_.ParentProcessId -in $selected -and $_.ProcessId -notin $selected} | ForEach-Object {[int]$_.ProcessId}); if(!$more.Count){break}; $selected+= $more; if($depth -eq 255){$remaining=@($all | Where-Object {$_.ParentProcessId -in $selected -and $_.ProcessId -notin $selected}); if($remaining.Count){throw 'PROCESS_TREE_DEPTH_LIMIT'}} }; " : "") +
    "$result=@($all | Where-Object {$_.ProcessId -in $selected} | ForEach-Object { $started=$_.CreationDate; if($started){ [pscustomobject]@{pid=[int]$_.ProcessId;parent_pid=[int]$_.ParentProcessId;started_at=$started.ToUniversalTime().ToString('o');executable=[string]$_.ExecutablePath} } }); ConvertTo-Json -InputObject $result -Compress";
  // A stripped environment makes Windows PowerShell rediscover where its own cmdlets live
  // before it can run any of them. On a cold CI runner that cost about 19 seconds per probe
  // against 0.3 seconds for the same query with the module path in place, so the module path
  // and the rest of the machine's own settings are forwarded. Only settings are forwarded,
  // never runtime keys or other secrets.
  const systemRoot = process.env.SYSTEMROOT || "C:\\Windows";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(systemroot|windir|systemdrive|path|pathext|psmodulepath|programdata|programfiles|programfiles\(x86\)|computername|number_of_processors|processor_architecture|userprofile|appdata|localappdata|temp|tmp)$/i.test(key)));
  if (!Object.keys(env).some(key => key.toUpperCase() === "PSMODULEPATH")) {
    env.PSModulePath = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  }
  const tool = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let stdout;
  try {
    // The first CIM query of a fresh session loads the provider, which is slow on a cold
    // machine. The answer is identity evidence, so a slow host must be given time instead
    // of being reported as a process that is not there.
    ({ stdout } = await exec(tool, ["-NoProfile", "-NonInteractive", "-Command", script],
      { env, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    // Why the probe failed is machine evidence: without it the failure looks like a
    // surviving process, and any reader is sent after the wrong cause.
    const reason = error?.killed ? `killed ${error?.signal ?? ""}` : `code ${error?.code ?? ""}`;
    throw platformError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE",
      `exec ${reason} ${String(error?.stderr ?? "").trim().slice(0, 200)}`.trim());
  }
  const text = stdout.replace(/^\uFEFF/, "").trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw platformError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE", `json ${text.slice(0, 200)}`); }
  // A single row comes back as an object because ConvertTo-Json unwraps one-item arrays.
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];
  throw platformError("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE", `shape ${text.slice(0, 200)}`);
}

export async function terminateProcessTree(pid, { run = exec, systemRoot = process.env.SystemRoot || "C:\\Windows" } = {}) {
  try {
    // path.win32: this is a Windows path even when a POSIX host is simulating win32.
    await run(path.win32.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 });
  } catch { throw platformError("REMOTE_PROCESS_TERMINATION_FAILED"); }
}
