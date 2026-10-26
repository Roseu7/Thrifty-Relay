import assert from "node:assert/strict";
import { classifyPath, effectiveTier, protectedPaths, sensitivePaths, windowIsOpen } from "../src/mcp/access.mjs";

// Two answers gate every operation: the tier it runs at, and what kind of path it touches.
// The assertions pin the order between those kinds, because a weaker answer winning by
// accident would turn a protected file into an allowed one without any code looking wrong.

const checks = [];

const WIN = {
  platform: "win32",
  home: "C:\\Users\\fixture",
  env: {
    ProgramData: "C:\\ProgramData",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    SystemRoot: "C:\\Windows",
  },
};
const WIN_POLICY = { workspace_roots: ["C:\\work"], protected_paths: ["C:\\tunnel-client"] };
const kind = options => classifyPath({ ...WIN, ...options });

// Design 2.2.4: the MCP's own files are protected even under full access, and the volume
// folds case, so a differently spelled path must reach the same answer.
assert.equal(kind({ target: "C:\\ProgramData\\ThriftyRelay\\policy.json" }).kind, "protected");
assert.equal(kind({ target: "c:\\programdata\\THRIFTYRELAY\\policy.json" }).kind, "protected");
assert.equal(kind({ target: "C:\\Users\\fixture\\AppData\\Roaming\\ThriftyRelay\\config.json" }).kind, "protected");
assert.equal(kind({ target: "C:\\Users\\fixture\\AppData\\Local\\ThriftyRelay\\tasks\\task.json" }).kind, "protected");
assert.equal(kind({ target: "C:\\Users\\fixture\\AppData\\Local\\ThriftyRelay\\Start-ThriftyRelay.ps1" }).kind, "protected");
assert.equal(kind({ target: "C:\\Users\\fixture\\AppData\\Local\\ThriftyRelay\\logs\\file.txt" }).kind, "protected");
const scratchRoot = "C:\\Users\\fixture\\AppData\\Local\\ThriftyRelay\\temp";
assert.equal(kind({ policy: { scratch_roots: [scratchRoot] }, target: scratchRoot + "\\task_test\\note.txt" }).kind, "scratch");
assert.equal(kind({ target: "C:\\Windows\\System32\\Tasks\\ThriftyRelay MCP" }).kind, "protected");
// Only the registration knows where the tunnel client was installed, so the policy records it.
assert.equal(kind({ policy: WIN_POLICY, target: "C:\\tunnel-client\\tunnel.exe" }).kind, "protected");
// A protected path stays protected even when it also matches a sensitive pattern.
assert.equal(kind({ policy: { ...WIN_POLICY, protected_paths: ["C:\\work\\.env"] }, target: "C:\\work\\.env" }).kind, "protected");
checks.push("protected-paths");

// Design 2.2.3: reading is not automatically safe. Names matter as much as directories,
// because a private key or a .env is sensitive wherever it sits.
assert.equal(kind({ target: "C:\\Users\\fixture\\.ssh\\id_ed25519" }).kind, "sensitive");
assert.equal(kind({ target: "C:\\Users\\fixture\\.aws\\credentials" }).kind, "sensitive");
assert.equal(kind({ target: "C:\\Users\\fixture\\.config\\gh\\hosts.yml" }).kind, "sensitive");
assert.equal(kind({ target: "C:\\Users\\fixture\\.codex\\auth.json" }).kind, "sensitive");
assert.equal(kind({ target: "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\Credentials\\DFBE70A7E5CC1" }).kind, "sensitive");
assert.equal(kind({ policy: WIN_POLICY, target: "C:\\work\\.env" }).kind, "sensitive");
assert.equal(kind({ policy: WIN_POLICY, target: "C:\\work\\.env.local" }).kind, "sensitive");
assert.equal(kind({ policy: WIN_POLICY, target: "C:\\work\\server.pem" }).kind, "sensitive");
assert.equal(kind({ policy: WIN_POLICY, target: "C:\\work\\id_rsa" }).kind, "sensitive");
assert.equal(kind({ policy: WIN_POLICY, target: "C:\\work\\notes.md" }).kind, "workspace");
checks.push("sensitive-paths");

assert.equal(kind({ policy: WIN_POLICY, target: "C:\\work\\src\\app.js" }).kind, "workspace");
// A sibling whose name merely starts with the root is not inside it.
assert.equal(kind({ policy: WIN_POLICY, target: "C:\\workbench\\app.js" }).kind, "outside");
assert.equal(kind({ policy: WIN_POLICY, target: "D:\\other\\notes.txt" }).kind, "outside");
// Without a policy nothing is inside a root, which is the state the design calls standard.
assert.equal(kind({ target: "C:\\Users\\fixture\\notes.txt" }).kind, "outside");
// Parent segments are resolved before the comparison, so a traversal does not escape a name.
assert.equal(kind({ policy: WIN_POLICY, target: "C:\\work\\sub\\..\\.env" }).kind, "sensitive");
assert.throws(() => kind({ target: "work\\notes.txt" }), { code: "ACCESS_PATH_NOT_ABSOLUTE" });
checks.push("workspace-and-outside");

// A registered scratch root answers before the workspace root, and the protected and sensitive
// lists still answer first. A sibling whose name only starts with the same prefix is not inside.
const SCRATCH_POLICY = {
  workspace_roots: ["C:\\work"],
  scratch_roots: ["C:\\work\\scratch"],
  protected_paths: ["C:\\work\\scratch\\protected"],
};
assert.equal(kind({ policy: SCRATCH_POLICY, target: "C:\\work\\scratch\\a.bin" }).kind, "scratch");
assert.equal(kind({ policy: SCRATCH_POLICY, target: "C:\\work\\scratch2\\a.bin" }).kind, "workspace");
assert.equal(kind({ policy: SCRATCH_POLICY, target: "C:\\work\\scratch\\.env" }).kind, "sensitive");
assert.equal(kind({ policy: SCRATCH_POLICY, target: "C:\\work\\scratch\\protected\\a.bin" }).kind, "protected");
checks.push("scratch-root-classification");

const LINUX = { platform: "linux", home: "/home/rose", env: { XDG_CONFIG_HOME: "/home/rose/.config" } };
const linux = options => classifyPath({ ...LINUX, ...options });
assert.equal(linux({ target: "/etc/thriftyrelay/policy.json" }).kind, "protected");
assert.equal(linux({ target: "/home/rose/.config/ThriftyRelay/config.json" }).kind, "protected");
assert.equal(linux({ target: "/home/rose/.local/state/thriftyrelay/runtime.json" }).kind, "protected");
// Linux volumes are case-sensitive, so the same spelling rules do not apply.
assert.equal(linux({ target: "/etc/THRIFTYRELAY/policy.json" }).kind, "outside");
assert.equal(linux({ target: "/home/rose/.ssh/config" }).kind, "sensitive");
assert.equal(linux({ policy: { workspace_roots: ["/home/rose/work"] }, target: "/home/rose/work/.env" }).kind, "sensitive");
assert.equal(linux({ policy: { workspace_roots: ["/home/rose/work"] }, target: "/home/rose/work/src/a.js" }).kind, "workspace");
assert.equal(linux({ policy: { scratch_roots: ["/home/rose/scratch"] }, target: "/home/rose/scratch/out.txt" }).kind, "scratch");
checks.push("posix-paths");

const DARWIN = { platform: "darwin", home: "/Users/rose", env: {} };
const darwin = options => classifyPath({ ...DARWIN, ...options });
assert.equal(darwin({ target: "/Library/Application Support/ThriftyRelay/policy.json" }).kind, "protected");
assert.equal(darwin({ target: "/Users/rose/Library/Application Support/ThriftyRelay/runtime.json" }).kind, "protected");
// APFS folds case by default, so a sensitive name cannot be escaped by capitalising it.
assert.equal(darwin({ target: "/Users/rose/.SSH/id_ed25519" }).kind, "sensitive");
assert.equal(darwin({ target: "/users/rose/Library/Application Support/Google/Chrome/Default/Login Data" }).kind, "sensitive");
checks.push("macos-paths");

// The lists are data from the platform conventions, not from the host, so a simulated
// platform answers as that platform would.
assert(protectedPaths({ ...WIN }).some(entry => entry.endsWith("ThriftyRelay")));
assert(sensitivePaths({ ...WIN }).every(entry => typeof entry === "string"));
checks.push("lists-follow-the-simulated-platform");

// Design 2.6.1: the configuration narrows, the policy widens. A policy that is missing,
// denied or silent cannot be turned into full access from the settings alone.
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const base = { kill_switch: false, full_access: { mode: "denied" } };
assert.deepEqual(effectiveTier({ configured: "trusted" }), { tier: "trusted", reason: "configured" });
assert.deepEqual(effectiveTier({ configured: "full" }), { tier: "standard", reason: "policy-missing" });
assert.deepEqual(effectiveTier({ configured: "full", policy: base }), { tier: "standard", reason: "policy-denied" });
assert.deepEqual(effectiveTier({ configured: "full", policy: { ...base, kill_switch: true } }), { tier: "standard", reason: "kill-switch" });
assert.deepEqual(effectiveTier({ configured: "full", policy: { ...base, full_access: { mode: "persistent" } } }), { tier: "full", reason: "persistent" });
// Narrowing wins even where the policy would allow more.
assert.deepEqual(effectiveTier({ configured: "standard", policy: { ...base, full_access: { mode: "persistent" } } }), { tier: "standard", reason: "configured" });
assert.throws(() => effectiveTier({ configured: "root" }), { code: "ACCESS_TIER_INVALID" });
checks.push("tier-resolution");

// A window is open only while its recorded end is in the future: an unparsable end, a closed
// record, or a stale one all read as closed, because none of them is evidence of permission.
const windowPolicy = { ...base, full_access: { mode: "window" } };
const open = { state: "open", expires_at: "2026-10-19T12:30:00.000Z" };
assert.deepEqual(effectiveTier({ configured: "full", policy: windowPolicy, window: open, now: NOW }), { tier: "full", reason: "window" });
assert.deepEqual(effectiveTier({ configured: "full", policy: windowPolicy, now: NOW }), { tier: "standard", reason: "window-closed" });
assert.deepEqual(effectiveTier({ configured: "full", policy: windowPolicy, window: { ...open, state: "closed" }, now: NOW }), { tier: "standard", reason: "window-closed" });
assert.deepEqual(effectiveTier({ configured: "full", policy: windowPolicy, window: { ...open, expires_at: "2026-10-19T11:59:59.000Z" }, now: NOW }), { tier: "standard", reason: "window-closed" });
assert.deepEqual(effectiveTier({ configured: "full", policy: windowPolicy, window: { state: "open", expires_at: "tomorrow" }, now: NOW }), { tier: "standard", reason: "window-closed" });
assert.equal(windowIsOpen(open, NOW), true);
assert.equal(windowIsOpen(null, NOW), false);
// A spent window's record still exists; it is the state, not the file, that decides.
assert.equal(windowIsOpen({ ...open, state: "consumed" }, NOW), false);
assert.equal(windowIsOpen({ ...open, state: "invalid" }, NOW), false);
checks.push("window-lifetime");

// A root that is the volume itself has no trailing separator to append, so containment has to
// compare the root's own form. Registering "C:\" as a workspace would otherwise make every
// path on the drive look outside it.
assert.equal(kind({ policy: { workspace_roots: ["C:\\"] }, target: "C:\\work\\a.js" }).kind, "workspace");
assert.equal(kind({ policy: { protected_paths: ["C:\\"] }, target: "C:\\work\\a.js" }).kind, "protected");
assert.equal(linux({ policy: { workspace_roots: ["/"] }, target: "/home/rose/work/a.js" }).kind, "workspace");
assert.equal(linux({ policy: { protected_paths: ["/"] }, target: "/home/rose/work/a.js" }).kind, "protected");
checks.push("volume-root-containment");

// Windows resolves alternate spellings to the same file. A classification that the filesystem
// does not honour is not enforcement, so the boundary refuses them instead of guessing.
assert.throws(() => kind({ policy: WIN_POLICY, target: "C:\\work\\.env::$DATA" }), { code: "ACCESS_PATH_UNSUPPORTED" });
assert.throws(() => kind({ policy: WIN_POLICY, target: "C:\\work\\.env." }), { code: "ACCESS_PATH_UNSUPPORTED" });
assert.throws(() => kind({ policy: WIN_POLICY, target: "C:\\work\\.env " }), { code: "ACCESS_PATH_UNSUPPORTED" });
assert.throws(() => kind({ target: "\\\\?\\C:\\work\\a.js" }), { code: "ACCESS_PATH_UNSUPPORTED" });
checks.push("windows-alternate-spellings");

// Windows keeps the credential stores of every browser it ships; each is a password database.
assert.equal(kind({ target: "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Login Data" }).kind, "sensitive");
assert.equal(kind({ target: "C:\\Users\\fixture\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Cookies" }).kind, "sensitive");
// Name patterns are folded everywhere: on a case-insensitive mount ".ENV" is the same file,
// and on a case-sensitive one refusing it costs a read rather than granting one.
assert.equal(linux({ policy: { workspace_roots: ["/home/rose/work"] }, target: "/home/rose/work/.ENV" }).kind, "sensitive");
checks.push("browser-and-case-folding");

console.log("PASS: " + checks.join(", "));
