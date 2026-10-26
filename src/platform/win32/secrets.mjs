import { spawn } from "node:child_process";
import path from "node:path";
import { Buffer } from "node:buffer";

export const CREDENTIAL_TARGET = "ThriftyRelay/CONTROL_PLANE_API_KEY";

export const CREDENTIAL_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$payload = $null
$credentialPointer = [IntPtr]::Zero
$blobPointer = [IntPtr]::Zero
$credentialBlobSize = 0
$blobBytes = $null
$secret = $null
$result = @{ ok = $false; code = 'CREDENTIAL_BACKEND_ERROR' }
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if (@('ThriftyRelay/CONTROL_PLANE_API_KEY') -notcontains [string]$payload.target) { throw 'invalid target' }
  $null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ThriftyRelayCredentialNative {
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public FileTime LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void CredFree(IntPtr credential);
}
'@
  if ($payload.operation -eq 'write') {
    $blobBytes = [Convert]::FromBase64String([string]$payload.secret_b64)
    $secret = [Text.Encoding]::UTF8.GetString($blobBytes)
    if ([string]::IsNullOrEmpty($secret) -or $secret.IndexOf([char]0) -ge 0) { throw 'invalid credential' }
    $credentialBlob = [Text.Encoding]::Unicode.GetBytes($secret)
    if ($credentialBlob.Length -gt 2560) { [Array]::Clear($credentialBlob, 0, $credentialBlob.Length); throw 'credential too long' }
    $blobPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($credentialBlob.Length)
    $credentialBlobSize = $credentialBlob.Length
    [Runtime.InteropServices.Marshal]::Copy($credentialBlob, 0, $blobPointer, $credentialBlob.Length)
    [Array]::Clear($credentialBlob, 0, $credentialBlob.Length)
    $credential = [Activator]::CreateInstance([type][ThriftyRelayCredentialNative+Credential])
    $credential.Type = 1
    $credential.TargetName = [string]$payload.target
    $credential.UserName = 'ThriftyRelay'
    $credential.CredentialBlobSize = [uint32][Text.Encoding]::Unicode.GetByteCount($secret)
    $credential.CredentialBlob = $blobPointer
    $credential.Persist = 2
    if (-not [ThriftyRelayCredentialNative]::CredWrite([ref]$credential, 0)) { throw 'write failed' }
    $result = @{ ok = $true; exists = $true }
  } elseif ($payload.operation -eq 'delete') {
    if ([ThriftyRelayCredentialNative]::CredDelete([string]$payload.target, 1, 0)) {
      $result = @{ ok = $true; removed = $true }
    } elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) {
      $result = @{ ok = $true; removed = $false }
    } else { throw 'credential delete failed' }
  } elseif ($payload.operation -eq 'read' -or $payload.operation -eq 'exists') {
    if ([ThriftyRelayCredentialNative]::CredRead([string]$payload.target, 1, 0, [ref]$credentialPointer)) {
      if ($payload.operation -eq 'read') {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPointer, [type][ThriftyRelayCredentialNative+Credential])
        if ($credential.CredentialBlobSize -gt 2560 -or ($credential.CredentialBlobSize % 2) -ne 0) { throw 'invalid credential blob' }
        $blobBytes = New-Object byte[] ([int]$credential.CredentialBlobSize)
        [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $blobBytes, 0, $blobBytes.Length)
        $secret = [Text.Encoding]::Unicode.GetString($blobBytes)
        $secretBytes = [Text.Encoding]::UTF8.GetBytes($secret)
        $result = @{ ok = $true; exists = $true; secret_b64 = [Convert]::ToBase64String($secretBytes) }
        [Array]::Clear($secretBytes, 0, $secretBytes.Length)
      } else {
        $result = @{ ok = $true; exists = $true }
      }
    } else {
      $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($nativeError -eq 1168) { $result = @{ ok = $true; exists = $false } }
      else { $result = @{ ok = $false; code = 'CREDENTIAL_READ_FAILED' } }
    }
  } else {
    throw 'invalid operation'
  }
} catch {
  $failureCode = 'CREDENTIAL_BACKEND_ERROR'
  if ($payload -and $payload.operation -eq 'write') { $failureCode = 'CREDENTIAL_WRITE_FAILED' }
  if ($payload -and $payload.operation -eq 'delete') { $failureCode = 'CREDENTIAL_DELETE_FAILED' }
  $result = @{ ok = $false; code = $failureCode }
} finally {
  if ($credentialPointer -ne [IntPtr]::Zero) { [ThriftyRelayCredentialNative]::CredFree($credentialPointer) }
  if ($blobPointer -ne [IntPtr]::Zero) {
    $zeroBlob = New-Object byte[] ([int]$credentialBlobSize)
    [Runtime.InteropServices.Marshal]::Copy($zeroBlob, 0, $blobPointer, $zeroBlob.Length)
    [Array]::Clear($zeroBlob, 0, $zeroBlob.Length)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blobPointer)
  }
  if ($blobBytes) { [Array]::Clear($blobBytes, 0, $blobBytes.Length) }
  $secret = $null
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
`;

async function runCredentialPowerShell(script, input) {
  if (process.platform !== "win32") throw Object.assign(new Error("CREDENTIAL_BACKEND_UNAVAILABLE"), { code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
  const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(systemroot|windir|path|userprofile|appdata|localappdata|temp|tmp)$/i.test(key)));
  const child = spawn(credentialHelperCommand(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    env: safeEnvironment,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  let overflow = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (stdout.length + chunk.length > 16384) overflow = true;
    else stdout += chunk;
  });
  let timeout;
  const completion = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    timeout = setTimeout(() => child.kill(), 15000);
    timeout.unref?.();
    child.once("error", () => finish(Object.assign(new Error("CREDENTIAL_BACKEND_ERROR"), { code: "CREDENTIAL_BACKEND_ERROR" })));
    child.once("close", code => {
      if (code !== 0 || overflow) finish(Object.assign(new Error("CREDENTIAL_BACKEND_ERROR"), { code: "CREDENTIAL_BACKEND_ERROR" }));
      else finish(null, stdout);
    });
  });
  child.stdin.on("error", () => child.kill());
  child.stdin.end(input, "utf8");
  return completion;
}

export function createCredentialStore({ platform = process.platform, run = runCredentialPowerShell } = {}) {
  async function invoke(operation, secret, target = CREDENTIAL_TARGET) {
    if (platform !== "win32") throw Object.assign(new Error("CREDENTIAL_BACKEND_UNAVAILABLE"), { code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
    const payload = {
      operation,
      target,
      ...(secret !== undefined ? { secret_b64: Buffer.from(secret, "utf8").toString("base64") } : {}),
    };
    let output;
    try { output = await run(CREDENTIAL_POWERSHELL, JSON.stringify(payload)); }
    catch { throw Object.assign(new Error("CREDENTIAL_BACKEND_ERROR"), { code: "CREDENTIAL_BACKEND_ERROR" }); }
    let result;
    try { result = JSON.parse(String(output).trim()); } catch {
      throw Object.assign(new Error("CREDENTIAL_BACKEND_ERROR"), { code: "CREDENTIAL_BACKEND_ERROR" });
    }
    if (result?.ok !== true) {
      const code = ["CREDENTIAL_READ_FAILED", "CREDENTIAL_WRITE_FAILED", "CREDENTIAL_DELETE_FAILED"].includes(result?.code)
        ? result.code : "CREDENTIAL_BACKEND_ERROR";
      throw Object.assign(new Error(code), { code });
    }
    return result;
  }

  return {
    async has() {
      const result = await invoke("exists");
      return result.exists === true;
    },
    async set(secret) {
      if (typeof secret !== "string" || !secret || Buffer.byteLength(secret, "utf16le") > 2560 || secret.includes("\0")) {
        throw Object.assign(new Error("CREDENTIAL_INPUT_INVALID"), { code: "CREDENTIAL_INPUT_INVALID" });
      }
      await invoke("write", secret);
      return true;
    },
    async get() {
      const result = await invoke("read");
      if (result.exists !== true) return { state: "missing" };
      if (typeof result.secret_b64 !== "string") {
        throw Object.assign(new Error("CREDENTIAL_BACKEND_ERROR"), { code: "CREDENTIAL_BACKEND_ERROR" });
      }
      let secret;
      try { secret = Buffer.from(result.secret_b64, "base64").toString("utf8"); } catch {
        throw Object.assign(new Error("CREDENTIAL_BACKEND_ERROR"), { code: "CREDENTIAL_BACKEND_ERROR" });
      }
      if (!secret) throw Object.assign(new Error("CREDENTIAL_BACKEND_ERROR"), { code: "CREDENTIAL_BACKEND_ERROR" });
      return { state: "registered", secret };
    },
    async delete(target = CREDENTIAL_TARGET) {
      const result = await invoke("delete", undefined, target);
      return result.removed === true;
    },
  };
}

export function credentialHelperCommand({ platform = process.platform, systemRoot = process.env.SystemRoot } = {}) {
  return platform === "win32"
    ? path.join(systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}
