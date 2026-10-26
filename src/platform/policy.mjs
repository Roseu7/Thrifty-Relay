import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

// The registration is a file only an administrator can create (design 2.6.1): the MCP may
// read it and must not be able to write it. Two consequences shape this module.
//
// Its location is a system directory and there is deliberately no environment override: a
// caller that could choose the location could point the MCP at a policy it wrote itself,
// and the registration would be a flag again.
//
// Protection is established by two real operations, not by asking fs.access, which answers
// from the read-only attribute on Windows and would miss an access control list that grants
// this user write access.
// "C:\work" and "\\server\share\work" name a place; "\work" is absolute to path.win32 but
// resolves against whichever drive the process happens to use, so it cannot be a root the
// registration means.
function isWindowsAbsolute(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

const LOCATIONS = {
  win32: {
    join: path.win32.join,
    isAbsolute: isWindowsAbsolute,
    // Fixed, not taken from the environment: ProgramData is a variable the process could be
    // launched with, and a registration whose location can be chosen by the process it
    // constrains is not a registration.
    directory: () => "C:\\ProgramData\\ThriftyRelay",
  },
  linux: {
    join: path.posix.join,
    isAbsolute: path.posix.isAbsolute,
    directory: () => "/etc/thriftyrelay",
  },
  darwin: {
    join: path.posix.join,
    isAbsolute: path.posix.isAbsolute,
    directory: () => "/Library/Application Support/ThriftyRelay",
  },
};

export const POLICY_FILE_NAME = "policy.json";

// "denied" is a complete registration: a policy that allows nothing still records that the
// decision was made, which is different from a host that was never registered.
const FULL_ACCESS_MODES = new Set(["denied", "window", "persistent"]);

function policyError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

function invalid(detail) {
  return policyError("POLICY_INVALID", detail);
}

function nonEmptyStrings(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw invalid(name + " must be a non empty array");
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") throw invalid(name + " must contain non empty strings");
  }
  return value.slice();
}

// A relative workspace root would resolve against whatever the process treats as the
// working directory, so the registration has to name where it means.
function absolutePaths(value, name, isAbsolute) {
  const entries = nonEmptyStrings(value, name);
  for (const entry of entries) {
    if (!isAbsolute(entry)) throw invalid(name + " must contain absolute paths");
  }
  return entries;
}

function absolutePathsOptional(value, name, isAbsolute) {
  // An explicit empty list and an absent one mean the same thing, and both are valid: a
  // registration that adds no protected path beyond the derived ones is complete.
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(name + " must be an array");
  if (value.length === 0) return [];
  return absolutePaths(value, name, isAbsolute);
}

export function policyFile({ platform = process.platform, env = process.env } = {}) {
  const conventions = LOCATIONS[platform];
  if (!conventions) throw policyError("REMOTE_PLATFORM_UNSUPPORTED");
  return conventions.join(conventions.directory(env), POLICY_FILE_NAME);
}

export function parsePolicy(text, platform = process.platform) {
  const conventions = LOCATIONS[platform];
  if (!conventions) throw policyError("REMOTE_PLATFORM_UNSUPPORTED");

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw invalid("not valid JSON");
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) throw invalid("not an object");

  // The generation is the revocation counter: raising it invalidates the approvals that
  // recorded the older value, so a policy without one cannot be honoured.
  if (!Number.isInteger(document.generation) || document.generation < 1) throw invalid("generation");
  if (typeof document.kill_switch !== "boolean") throw invalid("kill_switch");

  const fullAccess = document.full_access;
  if (fullAccess === null || typeof fullAccess !== "object" || Array.isArray(fullAccess)) throw invalid("full_access");
  if (!FULL_ACCESS_MODES.has(fullAccess.mode)) throw invalid("full_access.mode");
  // Duration and concurrency stay bounded; approval counts have no daily limit.
  const limits = {};
  if (fullAccess.mode !== "denied") {
    for (const name of ["max_minutes", "max_concurrent"]) {
      const value = fullAccess[name];
      if (!Number.isInteger(value) || value < 1) throw invalid("full_access." + name);
      limits[name] = value;
    }
  }

  return {
    generation: document.generation,
    kill_switch: document.kill_switch,
    full_access: { mode: fullAccess.mode, ...limits },
    // A registration that names no ingress could be claimed from anywhere, and the tunnel
    // identity is the only thing that ties an approval to the channel the user set up.
    tunnel_ids: nonEmptyStrings(document.tunnel_ids, "tunnel_ids"),
    workspace_roots: absolutePaths(document.workspace_roots, "workspace_roots", conventions.isAbsolute),
    // A scratch root is a disposable work area the registration allows without a window. It
    // is kept separate from workspace_roots so an operator can grant one without granting
    // the other, and so the absence of the field does not change an existing registration.
    scratch_roots: absolutePathsOptional(document.scratch_roots, "scratch_roots", conventions.isAbsolute),
    // Paths the registration knows and code cannot derive: the tunnel client and the
    // service definitions named in design 2.2.4.
    protected_paths: absolutePathsOptional(document.protected_paths, "protected_paths", conventions.isAbsolute),
  };
}

async function canWriteFile(file) {
  try {
    const handle = await fs.open(file, "r+");
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === "ENOENT") throw policyError("POLICY_MISSING", file);
    if (error.code === "EACCES" || error.code === "EPERM") return false;
    throw error;
  }
}

async function canCreateFile(probe) {
  try {
    const handle = await fs.open(probe, "wx");
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM") return false;
    throw error;
  }
}

// Either check alone can be satisfied while the registration is still replaceable: a file
// whose access control denies writes can be swapped out while its directory accepts new
// entries, and a locked directory does not keep writes out of a file that already grants
// them.
//
// The question is "can a non-administrator replace this", not "can this process write it".
// The registration is applied by the elevated CLI, and the MCP itself may run elevated (the
// Windows task is installed with the highest run level), so both can legitimately write a file
// that is still protected from the account the policy is protecting against. On Windows the
// stored access list is therefore the evidence; on POSIX the owner and mode are.
const ADMIN_SID = "S-1-5-32-544";
const SYSTEM_SID = "S-1-5-18";
const WRITE_RIGHT = /Write|Modify|FullControl|Delete|TakeOwnership|ChangePermissions/;
const PROTECTION_TTL_MS = 60_000;
const protectionCache = new Map();

function aclProtected(block = "") {
  const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const owner = (lines.find(line => line.startsWith("OWNER=")) || "").slice("OWNER=".length);
  // The owner can rewrite the list at any time, so ownership is part of the protection.
  if (owner !== ADMIN_SID && owner !== SYSTEM_SID) return false;
  return !lines.filter(line => line.startsWith("ACE=")).some(line => {
    const [sid, rights, access] = line.slice("ACE=".length).split("|");
    return access === "Allow" && WRITE_RIGHT.test(rights || "") && sid !== ADMIN_SID && sid !== SYSTEM_SID;
  });
}

// One PowerShell call answers for the file and its directory. .NET is used rather than Get-Acl
// so the check does not depend on the caller's module path, and SIDs are compared instead of
// localised account names.
async function windowsAclProtected(file) {
  const quote = value => value.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop';",
    "function Dump($p) {",
    "  $acl = if (Test-Path -LiteralPath $p -PathType Container) { [System.IO.Directory]::GetAccessControl($p) }",
    "    else { [System.IO.File]::GetAccessControl($p) };",
    "  'OWNER=' + $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;",
    "  $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |",
    "    ForEach-Object { 'ACE=' + $_.IdentityReference.Value + '|' + $_.FileSystemRights + '|' + $_.AccessControlType }",
    "}",
    "Dump '" + quote(file) + "'; '=='; Dump '" + quote(path.dirname(file)) + "'",
  ].join(" ");
  let stdout;
  try {
    ({ stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 }));
  } catch {
    // A check that could not run must not read as a pass.
    return false;
  }
  const [fileBlock, directoryBlock] = stdout.split("==");
  return aclProtected(fileBlock) && aclProtected(directoryBlock);
}

// root can always write, so the mode bits and the owner are what a root process has to reason
// from. A non-root process still asks the filesystem directly, which also covers POSIX ACLs.
function posixProtected(fileStat, directoryStat) {
  return fileStat.uid === 0 && (fileStat.mode & 0o222) === 0 &&
    directoryStat.uid === 0 && (directoryStat.mode & 0o022) === 0;
}

async function canCreateIn(directory) {
  const probe = path.join(directory, ".thriftyrelay-probe-" + randomBytes(6).toString("hex"));
  if (await canCreateFile(probe)) {
    await fs.rm(probe, { force: true });
    return true;
  }
  return false;
}

export async function assertProtectedPolicy(file, platform = process.platform, { fresh = false } = {}) {
  let fileStat, directoryStat;
  try {
    [fileStat, directoryStat] = await Promise.all([fs.stat(file), fs.stat(path.dirname(file))]);
  } catch (error) {
    if (error.code === "ENOENT") throw policyError("POLICY_MISSING", file);
    throw error;
  }
  const key = [file, fileStat.mtimeMs, fileStat.size, directoryStat.mtimeMs].join("|");
  const cached = protectionCache.get(file);
  if (!fresh && cached && cached.key === key && Date.now() - cached.at < PROTECTION_TTL_MS) return;

  let ok;
  if (platform === "win32") ok = await windowsAclProtected(file);
  else {
    // The owner can chmod the file back, so a registration this account owns is not protected
    // whatever the mode says. A non-root reader additionally probes the filesystem, which also
    // covers POSIX ACLs that the mode bits do not show.
    const privileged = typeof process.getuid === "function" && process.getuid() === 0;
    ok = posixProtected(fileStat, directoryStat) &&
      (privileged || (!(await canWriteFile(file)) && !(await canCreateIn(path.dirname(file)))));
  }

  if (!ok) throw policyError("POLICY_NOT_PROTECTED", "a non-administrator can replace the registration");
  protectionCache.set(file, { key, at: Date.now() });
}

// Reading is ordered so the failure names the real problem: a missing registration is not
// an invalid document, and a document this process could have written is not a registration
// even when its contents look right.
export async function readPolicy(file, platform = process.platform) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    throw error.code === "ENOENT" ? policyError("POLICY_MISSING", file) : error;
  }
  await assertProtectedPolicy(file, platform);
  return parsePolicy(text, platform);
}
