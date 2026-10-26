import { spawn } from "node:child_process";

const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = Math.ceil(MAX_RESPONSE_BYTES * 4 / 3) + 256;
const DEFAULT_TIMEOUT_MS = 20000;
const CLOSE_GRACE_MS = 1000;


function bootstrapScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$script:ResponseEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$script:MaximumResponseBytes = " + MAX_RESPONSE_BYTES,
    "[Console]::InputEncoding = $script:ResponseEncoding",
    "[Console]::OutputEncoding = $script:ResponseEncoding",
    "function Send-Response($response) {",
    "  $json = ConvertTo-Json -InputObject $response -Depth 3 -Compress",
    "  $bytes = $script:ResponseEncoding.GetBytes($json)",
    "  if ($bytes.Length -gt $script:MaximumResponseBytes) {",
    "    $json = ConvertTo-Json -InputObject ([pscustomobject]@{ id = [int]$response.id; ok = $false; outputLimit = $true }) -Compress",
    "    $bytes = $script:ResponseEncoding.GetBytes($json)",
    "  }",
    "  [Console]::Out.WriteLine('TR1:' + [string]$response.id + ':' + [Convert]::ToBase64String($bytes))",
    "  [Console]::Out.Flush()",
    "}",
    "Send-Response ([pscustomobject]@{ id = 0; ready = $true })",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($null -eq $line) { break }",
    "  $id = 0",
    "  try {",
    "    $request = ConvertFrom-Json -InputObject $line -ErrorAction Stop",
    "    $id = [int]$request.id",
    "    if ($id -le 0) { throw 'MCP_POWERSHELL_PROTOCOL_INVALID' }",
    "    $sourceBytes = [Convert]::FromBase64String([string]$request.script)",
    "    if ($sourceBytes.Length -gt " + MAX_SCRIPT_BYTES + ") { throw 'MCP_POWERSHELL_SCRIPT_TOO_LARGE' }",
    "    $source = [Text.Encoding]::UTF8.GetString($sourceBytes)",
    "    $items = @(& {",
    "      param([string]$Text)",
    "      $ErrorActionPreference = 'Stop'",
    "      $WarningPreference = 'SilentlyContinue'",
    "      $ProgressPreference = 'SilentlyContinue'",
    "      $InformationPreference = 'SilentlyContinue'",
    "      & ([ScriptBlock]::Create($Text))",
    "    } $source)",
    "    $parts = New-Object 'System.Collections.Generic.List[string]'",
    "    foreach ($item in $items) {",
    "      if ($null -eq $item) { continue }",
    "      if ($item -is [string]) { [void]$parts.Add($item) }",
    "      else { [void]$parts.Add(($item | Out-String -Width 4096).TrimEnd([char]13, [char]10)) }",
    "    }",
    "    $output = [string]::Join([Environment]::NewLine, $parts.ToArray())",
    "    Send-Response ([pscustomobject]@{ id = $id; ok = $true; output = $output })",
    "  } catch {",
    "    if ($id -gt 0) { Send-Response ([pscustomobject]@{ id = $id; ok = $false }) }",
    "    else { break }",
    "  }",
    "}",
  ].join("\n");
}

function safeError(code) {
  return Object.assign(new Error(), { code });
}

function executablePath() {
  return process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
}

export class PowerShellSession {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, executable = executablePath(), spawnProcess = spawn } = {}) {
    this.timeoutMs = timeoutMs;
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.stdoutBuffer = "";
    this.nextId = 1;
    this.closed = false;
    this.expectedExit = false;
    this.failure = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyTimer = null;
    this.closePromise = null;
  }

  run(script, code) {
    if (typeof script !== "string" || Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) {
      return Promise.reject(safeError(code || "MCP_POWERSHELL_SESSION_FAILED"));
    }
    const operation = this.queue.then(() => this.execute(script, code));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async execute(script, code) {
    const failureCode = code || "MCP_POWERSHELL_SESSION_FAILED";
    try {
      if (this.closed || this.failure) throw safeError(failureCode);
      await this.start();
      if (this.closed || this.failure) throw safeError(failureCode);
      const id = this.nextId++;
      const encodedScript = Buffer.from(script, "utf8").toString("base64");
      const request = JSON.stringify({ id, script: encodedScript }) + "\n";
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.fail(safeError(failureCode));
        }, this.timeoutMs);
        this.pending = { id, code: failureCode, resolve, reject, timer };
        try {
          this.child.stdin.write(request, "ascii", error => {
            if (error) this.fail(safeError(failureCode));
          });
        } catch {
          this.fail(safeError(failureCode));
        }
      });
      return response;
    } catch {
      await this.stopProcess();
      throw safeError(failureCode);
    }
  }

  async start() {
    if (this.failure) throw this.failure;
    if (this.readyPromise) return this.readyPromise;
    if (this.closed) throw safeError("MCP_POWERSHELL_SESSION_CLOSED");

    const encodedBootstrap = Buffer.from(bootstrapScript(), "utf16le").toString("base64");
    try {
      this.child = this.spawnProcess(this.executable, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedBootstrap,
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      this.fail(safeError("MCP_POWERSHELL_SESSION_FAILED"));
      throw this.failure;
    }

    this.closePromise = new Promise(resolve => this.child.once("close", resolve));
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => this.fail(safeError("MCP_POWERSHELL_SESSION_FAILED")), this.timeoutMs);
    });
    this.child.stdout.on("data", chunk => this.readStdout(chunk));
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.fail(safeError("MCP_POWERSHELL_SESSION_FAILED")));
    this.child.once("error", () => this.fail(safeError("MCP_POWERSHELL_SESSION_FAILED")));
    this.child.once("close", () => {
      if (!this.expectedExit) this.fail(safeError("MCP_POWERSHELL_SESSION_FAILED"));
    });
    return this.readyPromise;
  }

  readStdout(chunk) {
    if (this.failure || this.closed) return;
    this.stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_FRAME_BYTES) this.fail(safeError("MCP_POWERSHELL_SESSION_FAILED"));
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES || !this.readFrame(line)) {
        this.fail(safeError("MCP_POWERSHELL_SESSION_FAILED"));
        return;
      }
      if (this.failure || this.closed) return;
    }
  }

  readFrame(line) {
    const match = /^TR1:(\d+):([A-Za-z0-9+/=]+)$/.exec(line);
    if (!match) return false;
    let response;
    try {
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > MAX_RESPONSE_BYTES) return false;
      response = JSON.parse(bytes.toString("utf8"));
    } catch {
      return false;
    }
    const id = Number(match[1]);
    if (id === 0) {
      if (this.readyResolve === null || response.id !== 0 || response.ready !== true) return false;
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
      const resolve = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      resolve();
      return true;
    }
    const pending = this.pending;
    if (!pending || pending.id !== id || response.id !== id || typeof response.ok !== "boolean") return false;
    this.pending = null;
    clearTimeout(pending.timer);
    if (response.ok !== true || typeof response.output !== "string" ||
        Buffer.byteLength(response.output, "utf8") > MAX_RESPONSE_BYTES) {
      const error = safeError(pending.code);
      pending.reject(error);
      this.fail(error);
      return true;
    }
    pending.resolve(response.output);
    return true;
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error || safeError("MCP_POWERSHELL_SESSION_FAILED");
    this.closed = true;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (this.readyReject) {
      const reject = this.readyReject;
      this.readyResolve = null;
      this.readyReject = null;
      reject(this.failure);
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    if (this.child && !this.child.killed) {
      this.expectedExit = true;
      try { this.child.kill(); } catch {}
    }
  }

  async stopProcess() {
    this.closed = true;
    if (!this.child || !this.closePromise) return;
    if (!this.failure && this.pending) this.fail(safeError("MCP_POWERSHELL_SESSION_CLOSED"));
    if (!this.failure && !this.expectedExit) {
      this.expectedExit = true;
      try { this.child.stdin.end(); } catch { this.fail(safeError("MCP_POWERSHELL_SESSION_FAILED")); }
    }
    let timer;
    const exited = await Promise.race([
      this.closePromise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS); }),
    ]);
    clearTimeout(timer);
    if (!exited) {
      this.expectedExit = true;
      try { this.child.kill(); } catch {}
      await this.closePromise;
    }
  }

  async close() {
    if (this.closed && (!this.child || this.failure || this.expectedExit)) {
      if (this.child && this.closePromise) await this.closePromise;
      return;
    }
    this.closed = true;
    if (this.pending || this.readyReject) this.fail(safeError("MCP_POWERSHELL_SESSION_CLOSED"));
    await this.stopProcess();
  }
}

export const powerShellSessionLimits = Object.freeze({
  maxScriptBytes: MAX_SCRIPT_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
});
