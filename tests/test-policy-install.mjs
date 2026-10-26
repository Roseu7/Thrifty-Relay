import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertProtectedPolicy } from "../src/platform/index.mjs";
import { commandOf, nextRegistration, parseArguments } from "../scripts/register-policy.mjs";

// The registration is the only permission change a card cannot make, so two things have to
// hold: the arguments cannot produce a policy the preview did not show, and the installed
// file is one the unprivileged account cannot write. The access list is asserted by SID
// rather than by trying to write, because the result must not depend on who runs the tests.

const execFileAsync = promisify(execFile);
const WINDOWS = process.platform === "win32";
const checks = [];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-install-"));
const hostRoot = WINDOWS ? "C:\\work" : "/work";
const hostScratch = WINDOWS ? "C:\\scratch" : "/scratch";

const DRAFT = JSON.stringify({
  generation: 7,
  kill_switch: false,
  full_access: { mode: "window", max_minutes: 30, max_concurrent: 1 },
  tunnel_ids: ["tunnel_0123456789abcdef0123456789abcdef"],
  workspace_roots: [hostRoot],
  scratch_roots: [hostScratch],
});

assert.deepEqual(parseArguments(["--show"]), { yes: false, show: true });
assert.deepEqual(parseArguments(["--revoke", "--kill-switch", "on"]), { yes: false, revoke: true, killSwitch: "on" });
assert.equal(commandOf({ show: true }), "show");
assert.equal(commandOf({ file: "draft.json" }), "write");
assert.equal(commandOf({ revoke: true, killSwitch: "off" }), "write");
assert.equal(commandOf({ apply: "p.json", sha256: "a".repeat(64) }), "apply");
// The expected generation belongs to the elevated child only: it is how a revocation that
// happened while the preview was on screen cannot be undone by a stale write.
assert.equal(commandOf({ apply: "p.json", sha256: "a".repeat(64), expect: "3" }), "apply");
assert.equal(parseArguments(["--apply", "p.json", "--sha256", "x", "--expect", "3"]).expect, "3");
assert.throws(() => commandOf({ expect: "3" }), { code: "REGISTER_ARGUMENTS_INVALID" });
assert.throws(() => commandOf({}), { code: "REGISTER_ARGUMENTS_INVALID" });
assert.throws(() => commandOf({ file: "x", revoke: true }), { code: "REGISTER_ARGUMENTS_INVALID" });
assert.throws(() => parseArguments(["--nope"]), { code: "REGISTER_ARGUMENT_UNKNOWN" });
checks.push("arguments");

// The draft carries a generation, and it is deliberately ignored: only the installer decides
// the counter, so a stale file cannot roll a revocation back.
const initial = nextRegistration({ draft: DRAFT, platform: process.platform });
assert.equal(initial.policy.generation, 1);
assert.equal(initial.policy.kill_switch, false);
assert.deepEqual(initial.policy.workspace_roots, [hostRoot]);
assert.deepEqual(initial.policy.scratch_roots, [hostScratch]);
assert(initial.text.endsWith("\n"));
const revoked = nextRegistration({ current: initial.policy, platform: process.platform });
assert.equal(revoked.policy.generation, 2);
assert.deepEqual(revoked.policy.workspace_roots, initial.policy.workspace_roots);
assert.deepEqual(revoked.policy.scratch_roots, [hostScratch]);
const killed = nextRegistration({ current: initial.policy, killSwitch: true, platform: process.platform });
assert.equal(killed.policy.generation, 2);
assert.equal(killed.policy.kill_switch, true);
assert.deepEqual(killed.policy.scratch_roots, [hostScratch]);
assert.throws(() => nextRegistration({}), { code: "POLICY_MISSING" });
assert.throws(() => nextRegistration({ draft: "{}", platform: process.platform }), { code: "POLICY_INVALID" });
checks.push("generation-and-switch");

const target = path.join(root, "ThriftyRelay", "policy.json");

if (WINDOWS) {
  const { installPolicy } = await import("../src/platform/win32/policy-install.mjs");
  // Taking ownership is the step that makes the registration an elevated operation, so a
  // standard account is refused before anything is written. The runner may or may not be
  // elevated; each branch asserts the invariant that belongs to it.
  const installed = await installPolicy({ file: target, content: initial.text }).then(() => true, error => {
    if (error.code === "POLICY_INSTALL_PRIVILEGE_REQUIRED") return false;
    throw error;
  });

  if (!installed) {
    assert.equal(await fs.stat(target).then(() => true).catch(() => false), false, "nothing may be written without the privilege");
    checks.push("windows-requires-elevation");
  } else {
    assert.equal(await fs.readFile(target, "utf8"), initial.text);
    assert.equal(await fs.stat(target + ".new").then(() => true).catch(() => false), false);

    const powershell = async script => {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, timeout: 20000 });
      return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    };
    // .NET is used rather than Get-Acl: the Security module is not loadable when the caller's
    // environment has no PSModulePath, and a test that depends on the caller's environment
    // would report a registration failure that is really a missing module.
    const accessList = location => powershell(
      "$acl = [System.IO.File]::GetAccessControl('" + location.replaceAll("'", "''") + "'); " +
      "$acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value + ':' + $_.FileSystemRights + ':' + $_.AccessControlType }");
    const owner = location => powershell(
      "$acl = [System.IO.File]::GetAccessControl('" + location.replaceAll("'", "''") + "'); " +
      "$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value");

    const fileAcl = await accessList(target);
    const users = fileAcl.filter(line => line.startsWith("S-1-5-32-545:"));
    assert(users.length > 0, "the policy must name the Users group explicitly");
    assert(users.every(line => line.endsWith(":Allow") && !/Write|Modify|FullControl/.test(line)), users.join(" | "));
    assert(fileAcl.some(line => line.startsWith("S-1-5-32-544:") && line.includes("FullControl")));
    assert(fileAcl.some(line => line.startsWith("S-1-5-18:") && line.includes("FullControl")));

    const directoryAcl = await accessList(path.dirname(target));
    const directoryUsers = directoryAcl.filter(line => line.startsWith("S-1-5-32-545:"));
    assert(directoryUsers.length > 0);
    assert(directoryUsers.every(line => line.endsWith(":Allow") && !/Write|Modify|FullControl/.test(line)), directoryUsers.join(" | "));

    // An owner can rewrite the list whenever it likes, so ownership is the part that decides
    // whether the registration can be taken back by the account the MCP runs as.
    assert.deepEqual(await owner(target), ["S-1-5-32-544"]);
    assert.deepEqual(await owner(path.dirname(target)), ["S-1-5-32-544"]);

    // The check the MCP itself runs. It reads the stored access list, so it also holds when the
    // caller is elevated — which the registration CLI always is.
    await assertProtectedPolicy(target, "win32", { fresh: true });
    // A write grant to Users makes the same check fail, so a passing check means something.
    await execFileAsync("icacls", [target, "/grant:r", "*S-1-5-32-545:W"], { windowsHide: true, timeout: 20000 });
    await assert.rejects(assertProtectedPolicy(target, "win32", { fresh: true }), { code: "POLICY_NOT_PROTECTED" });
    await execFileAsync("icacls", [target, "/grant:r", "*S-1-5-32-545:R"], { windowsHide: true, timeout: 20000 });
    await assertProtectedPolicy(target, "win32", { fresh: true });
    checks.push("windows-protection-check");
    checks.push("windows-access-list");
  }

  // A junction where the registration belongs would redirect the elevated write, and the
  // refusal happens before anything is created.
  const junction = path.join(root, "linked");
  await fs.symlink(root, junction, "junction");
  await assert.rejects(installPolicy({ file: path.join(junction, "policy.json"), content: initial.text }), { code: "POLICY_INSTALL_PATH_UNSAFE" });
  checks.push("rejects-linked-path");

  if (installed) {
    // Deleting the locked tree needs write access back on the directory, not on the file.
    await execFileAsync("icacls", [path.dirname(target), "/grant:r", "*S-1-5-32-545:(OI)(CI)F"], { windowsHide: true, timeout: 20000 });
  }
} else {
  const { installPolicy } = await import("../src/platform/posix/policy-install.mjs");
  const privileged = typeof process.getuid === "function" && process.getuid() === 0;
  if (privileged) {
    await installPolicy({ file: target, content: initial.text });
    const file = await fs.stat(target);
    const directory = await fs.stat(path.dirname(target));
    assert.equal(file.mode & 0o777, 0o444);
    assert.equal(directory.mode & 0o777, 0o555);
    // Ownership is what makes 0444 more than a mode bit: the owner could chmod it back.
    assert.equal(file.uid, 0);
    assert.equal(directory.uid, 0);
    assert.equal(await fs.readFile(target, "utf8"), initial.text);
    // root can write a 0444 file, so the check has to read the owner and mode instead.
    await assertProtectedPolicy(target, "posix", { fresh: true });
    await fs.chmod(target, 0o644);
    await assert.rejects(assertProtectedPolicy(target, "posix", { fresh: true }), { code: "POLICY_NOT_PROTECTED" });
    await fs.chmod(target, 0o444);
    await fs.chmod(path.dirname(target), 0o755);
    checks.push("posix-permissions");
    checks.push("posix-protection-check");
  } else {
    // The installer is the only writer, so an account that is not root must not create even
    // the mode bits that would make the file look registered.
    await assert.rejects(installPolicy({ file: target, content: initial.text }), { code: "POLICY_INSTALL_PRIVILEGE_REQUIRED" });
    assert.equal(await fs.stat(path.dirname(target)).then(() => true).catch(() => false), false);
    checks.push("posix-requires-root");
  }
}

await fs.rm(root, { recursive: true, force: true });
console.log("PASS: " + checks.join(", "));
