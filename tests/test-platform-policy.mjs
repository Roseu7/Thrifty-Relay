import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertProtectedPolicy, parsePolicy, policyFile, readPolicy } from "../src/platform/index.mjs";

// The policy file is the registration itself (design 2.6.1), so this adapter's mistakes are
// not recoverable by a later fix: a policy this process could have written is not a
// registration, and a policy it cannot read leaves every operation unexplained. The
// assertions below pin the locations, the document schema, and the two access checks that
// make the file a boundary rather than a suggestion.

const checks = [];

const DOCUMENT = {
  generation: 1,
  kill_switch: false,
  full_access: { mode: "window", max_minutes: 30, max_concurrent: 1 },
  tunnel_ids: ["tunnel_fixture"],
  workspace_roots: ["/workspace"],
};
const text = value => JSON.stringify(value);

assert.throws(() => policyFile({ platform: "aix", env: {} }), { code: "REMOTE_PLATFORM_UNSUPPORTED" });
assert.throws(() => parsePolicy(text(DOCUMENT), "aix"), { code: "REMOTE_PLATFORM_UNSUPPORTED" });
checks.push("unsupported-platform-fails-loudly");

// Only the location differs between the supported systems. The Windows location is fixed
// rather than read from ProgramData: a value taken from the environment is a location the
// launched process can choose, and a registration whose location the constrained process
// chooses is not a registration.
assert.equal(policyFile({ platform: "win32", env: { ProgramData: "C:\\ProgramData" } }),
  "C:\\ProgramData\\ThriftyRelay\\policy.json");
assert.equal(policyFile({ platform: "win32", env: {} }), "C:\\ProgramData\\ThriftyRelay\\policy.json");
assert.equal(policyFile({ platform: "win32", env: { ProgramData: "C:\\Users\\f\\AppData\\Local\\Temp" } }),
  "C:\\ProgramData\\ThriftyRelay\\policy.json");
assert.equal(policyFile({ platform: "linux", env: {} }), "/etc/thriftyrelay/policy.json");
assert.equal(policyFile({ platform: "darwin", env: {} }), "/Library/Application Support/ThriftyRelay/policy.json");
checks.push("registration-location");

// There is deliberately no environment override, unlike the configuration file: a caller
// that could point the MCP at a policy it wrote would make the registration a flag again.
assert.equal(policyFile({ platform: "linux", env: { THRIFTYRELAY_POLICY_PATH: "/tmp/policy.json" } }),
  "/etc/thriftyrelay/policy.json");
checks.push("registration-has-no-environment-override");

// The schema is the shape the registration writes, and every value in it replaces a decision
// the MCP would otherwise have to guess: the generation for revocation, the tunnels for the
// ingress, the roots for the scope, the limits for how long full access may last.
assert.deepEqual(parsePolicy(text(DOCUMENT), "linux"), { ...DOCUMENT, scratch_roots: [], protected_paths: [] });
assert.deepEqual(parsePolicy(text({ ...DOCUMENT, full_access: { ...DOCUMENT.full_access, max_per_day: 2 } }), "linux"),
  { ...DOCUMENT, scratch_roots: [], protected_paths: [] });
assert.deepEqual(parsePolicy(text({ ...DOCUMENT, scratch_roots: ["/tmp/scratch"] }), "linux").scratch_roots, ["/tmp/scratch"]);
assert.deepEqual(parsePolicy(text({ ...DOCUMENT, scratch_roots: [] }), "linux").scratch_roots, []);
assert.equal(parsePolicy(text({ ...DOCUMENT, protected_paths: ["/opt/tunnel-client"] }), "linux").protected_paths[0],
  "/opt/tunnel-client");
// Writing the list back as an explicit empty array is the same registration as omitting it;
// the installer always emits the field, so refusing the empty form would make its own output
// unreadable.
assert.deepEqual(parsePolicy(text({ ...DOCUMENT, protected_paths: [] }), "linux").protected_paths, []);
// A registration that allows nothing is still a complete document, and the limits are then
// absent because no card can grant one.
assert.equal(parsePolicy(text({ ...DOCUMENT, full_access: { mode: "denied" } }), "linux").full_access.mode, "denied");
// Roots are absolute in the shape of the platform that will open them: "workspace/src" is
// relative on both, and Windows would resolve "/workspace" against the current drive.
assert.deepEqual(parsePolicy(text({ ...DOCUMENT, workspace_roots: ["C:\\workspace"] }), "win32").workspace_roots,
  ["C:\\workspace"]);
for (const [rejected, value] of [
  ["not-json", "{"],
  ["not-an-object", "[]"],
  ["generation-zero", text({ ...DOCUMENT, generation: 0 })],
  ["generation-type", text({ ...DOCUMENT, generation: "1" })],
  ["kill-switch", text({ ...DOCUMENT, kill_switch: "off" })],
  ["mode", text({ ...DOCUMENT, full_access: { mode: "sometimes" } })],
  ["window-bound-missing", text({ ...DOCUMENT, full_access: { mode: "window" } })],
  ["window-bound-zero", text({ ...DOCUMENT, full_access: { mode: "window", max_minutes: 0, max_concurrent: 1 } })],
  ["tunnels", text({ ...DOCUMENT, tunnel_ids: [] })],
  ["relative-root", text({ ...DOCUMENT, workspace_roots: ["workspace/src"] })],
  ["relative-root-win32", text({ ...DOCUMENT, workspace_roots: ["workspace\\src"] })],
  ["relative-scratch", text({ ...DOCUMENT, scratch_roots: ["scratch"] })],
  ["scratch-paths", text({ ...DOCUMENT, scratch_roots: "all" })],
  // "\work" is absolute to path.win32 but resolves against whichever drive the process uses.
  ["drive-relative-root-win32", text({ ...DOCUMENT, workspace_roots: ["\\work"] })],
  ["protected-paths", text({ ...DOCUMENT, protected_paths: "all" })],
]) {
  const platform = rejected.endsWith("-win32") ? "win32" : "linux";
  assert.throws(() => parsePolicy(value, platform), { code: "POLICY_INVALID" }, rejected);
}
checks.push("document-schema");

// Replacing a registration takes two operations - writing the file, or creating a new entry
// in its directory, which is all a rename needs - so both are checked. The question is whether
// a non-administrator could do either, so the test grants Users the right in question instead
// of relying on the token this test happens to run under: an elevated Windows process can write
// a file that is still protected from the account the policy is protecting against.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-policy-"));
const file = path.join(directory, "policy.json");
const hostRoot = process.platform === "win32" ? "C:\\workspace" : "/workspace";
const hostDocument = { ...DOCUMENT, workspace_roots: [hostRoot] };
const rejects = () => assert.rejects(assertProtectedPolicy(file, process.platform, { fresh: true }),
  { code: "POLICY_NOT_PROTECTED" });

try {
  await fs.writeFile(file, text(hostDocument));

  if (process.platform === "win32") {
    const icacls = (target, ...arguments_) => promisify(execFile)("icacls", [target, ...arguments_],
      { windowsHide: true, timeout: 20_000 });
    // Users may write the file itself.
    await icacls(file, "/grant", "*S-1-5-32-545:W");
    await rejects();
    await icacls(file, "/remove", "*S-1-5-32-545");
    // Users may create an entry beside it, which is enough for a rename to replace it.
    await icacls(directory, "/grant", "*S-1-5-32-545:W");
    await fs.rm(file, { force: true });
    await fs.writeFile(file, text(hostDocument));
    await rejects();
    checks.push("registration-is-two-access-checks");
  } else {
    // A file this account owns is replaceable whatever its mode: the owner can chmod it back.
    await fs.chmod(file, 0o444);
    await rejects();

    // Only root ownership makes the mode bits mean anything; a non-root run has no way to
    // reach the protected state, which is why the installer refuses without root.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      await fs.chmod(directory, 0o555);
      assert.deepEqual(await readPolicy(file, "posix"), { ...hostDocument, scratch_roots: [], protected_paths: [] });
      await fs.chmod(file, 0o666);

      await fs.writeFile(file, "{");
      await fs.chmod(file, 0o444);
      await assert.rejects(readPolicy(file, "posix"), { code: "POLICY_INVALID" });
      await fs.chmod(directory, 0o755);
    }
    checks.push("registration-is-two-access-checks");
  }

  // A host that was never registered must not look like a host whose policy allows nothing.
  await fs.rm(file, { force: true });
  await assert.rejects(readPolicy(file, process.platform), { code: "POLICY_MISSING" });
  await assert.rejects(assertProtectedPolicy(file), { code: "POLICY_MISSING" });
} finally {
  await fs.chmod(directory, 0o755).catch(() => {});
  await fs.chmod(file, 0o666).catch(() => {});
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
}

console.log("PASS: " + checks.join(", "));
