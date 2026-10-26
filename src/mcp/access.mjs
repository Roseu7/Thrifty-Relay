import path from "node:path";
import { getConfigPath } from "../i18n/index.mjs";
import { pathsAdapter, policyFile } from "../platform/index.mjs";

// Two questions decide every operation: which tier it runs at, and where the path it touches
// sits relative to the registration. Both are answered here, once, from the policy and the
// user configuration. A second copy of this logic inside a tool is how enforcement becomes a
// declaration again (design 2.2).
//
// The user configuration can only narrow: a tier of "full" is honoured when the policy
// allows it, which is the asymmetry the registration rests on (design 2.6.1).

export const TIERS = Object.freeze(["standard", "trusted", "full"]);

// Name patterns, not paths: a private key or a .env is sensitive wherever it sits, which is
// why the list carries basenames as well as directories.
const SENSITIVE_NAMES = Object.freeze([
  ".env", ".env.*", "*.pem", "*.key", "id_*",
  ".bash_history", ".zsh_history", ".history", ".python_history", ".node_repl_history",
]);

function flavour(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function accessError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

// A protected root that is the volume itself ("/" or "C:\") has no trailing separator to add,
// and adding one would compare against "//" and never match. Containment is therefore written
// so that the root's own form is complete, not "root plus separators".
function contains(platform, root, target) {
  const paths = pathsAdapter(platform);
  const separator = flavour(platform).sep;
  const base = paths.comparisonKey(root);
  const value = paths.comparisonKey(target);
  if (value === base) return true;
  return value.startsWith(base.endsWith(separator) ? base : base + separator);
}

// Windows resolves a name through a second spelling that this list would not recognise:
// an alternate data stream (".env::$DATA" is the unnamed stream of .env), a trailing dot or
// space, or a device path. Those spellings are refused at the boundary instead of being
// classified, because a classification the filesystem does not honour is not enforcement.
function assertPlainWindowsPath(target) {
  if (/^\\\\[?.]\\/.test(target)) throw accessError("ACCESS_PATH_UNSUPPORTED", target);
  const rest = /^[a-zA-Z]:/.test(target) ? target.slice(2) : target;
  if (rest.includes(":")) throw accessError("ACCESS_PATH_UNSUPPORTED", target);
  for (const segment of rest.split(/[\\/]/)) {
    // "." and ".." resolve to a name the caller did not spell, and neither is a file name.
    if (segment === "" || segment === "." || segment === "..") continue;
    if (/[ .]$/.test(segment)) throw accessError("ACCESS_PATH_UNSUPPORTED", target);
  }
}

// A pattern is folded on every platform: on a volume that folds case the differently spelled
// name is the same file, and on one that does not, folding denies a read instead of granting
// one. A false positive is the side to err on.
function nameMatches(pattern, name) {
  const source = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp("^" + source + "$").test(name.toLowerCase());
}

// Design 2.2.4: the accident that matters is breaking the MCP itself, so its own files are
// protected even under full access. What only the registration knows - the tunnel client and
// the service definition - travels in the policy instead.
export function protectedPaths({ platform = process.platform, env = process.env, home, appDirectory }) {
  const join = flavour(platform).join;
  const entries = [
    flavour(platform).dirname(policyFile({ platform, env })),
    getConfigPath({ env, platform, home }),
    pathsAdapter(platform).taskDirectory({ env, home }),
  ];
  // Runtime control files are not writable by any remote tier: a remote write could
  // replace the lock or state record that `stop` relies on.
  if (typeof pathsAdapter(platform).runtimeDirectory === "function") {
    entries.push(pathsAdapter(platform).runtimeDirectory({ env, home }));
  }
  if (appDirectory) entries.push(appDirectory);
  if (platform === "win32") {
    const local = join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ThriftyRelay");
    entries.push(...["Start-ThriftyRelay.ps1", "logs", "tasks"].map(name => join(local, name)));
    // The scheduled task definitions live in one directory; the service adapter owns their
    // content, but a write here is never something a remote instruction may do.
    entries.push(join(env.SystemRoot || "C:\\Windows", "System32", "Tasks"));
  }
  return entries;
}

// Design 2.2.3: reading is not automatically safe. Registry-backed credentials are exposed
// here as the vault files Windows keeps for them, because a path rule cannot describe the
// credential manager itself. Every browser that keeps a password or cookie store in a file is
// listed: leaving one out makes it a workspace file as soon as the home directory is a root.
export function sensitivePaths({ platform = process.platform, env = process.env, home }) {
  const join = flavour(platform).join;
  const entries = [
    join(home, ".ssh"), join(home, ".aws"), join(home, ".config", "gh"),
    join(home, ".codex", "auth.json"),
    ...SENSITIVE_NAMES,
  ];
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const roaming = env.APPDATA || join(home, "AppData", "Roaming");
    entries.push(
      join(local, "Google", "Chrome", "User Data"), join(roaming, "Mozilla", "Firefox", "Profiles"),
      join(local, "Microsoft", "Edge", "User Data"), join(local, "Chromium", "User Data"),
      join(local, "BraveSoftware", "Brave-Browser", "User Data"), join(local, "Vivaldi", "User Data"),
      join(roaming, "Opera Software", "Opera Stable"),
      join(local, "Microsoft", "Credentials"), join(roaming, "Microsoft", "Credentials"),
    );
  } else if (platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    entries.push(
      join(support, "Google", "Chrome"), join(support, "Firefox"),
      join(support, "Microsoft Edge"), join(support, "Chromium"),
      join(support, "BraveSoftware", "Brave-Browser"), join(support, "Vivaldi"),
      join(support, "com.operasoftware.Opera"),
    );
  } else {
    const config = join(home, ".config");
    entries.push(
      join(config, "google-chrome"), join(config, "mozilla", "firefox"),
      join(config, "microsoft-edge"), join(config, "chromium"),
      join(config, "BraveSoftware", "Brave-Browser"), join(config, "vivaldi"), join(config, "opera"),
    );
  }
  return entries;
}

// The order is the decision: a protected path stays protected even when it also looks
// sensitive, so no later check can turn the strictest answer into a weaker one.
export function classifyPath({
  platform = process.platform,
  env = process.env,
  home,
  appDirectory,
  target,
  policy = {},
  extraProtected = [],
  extraSensitive = [],
} = {}) {
  const isAbsolute = flavour(platform).isAbsolute;
  if (typeof target !== "string" || !isAbsolute(target)) throw accessError("ACCESS_PATH_NOT_ABSOLUTE");
  if (platform === "win32") assertPlainWindowsPath(target);

  for (const root of [...protectedPaths({ platform, env, home, appDirectory }), ...(policy.protected_paths || []), ...extraProtected]) {
    if (contains(platform, root, target)) return { kind: "protected", root };
  }

  const name = flavour(platform).basename(target);
  for (const entry of [...sensitivePaths({ platform, env, home }), ...extraSensitive]) {
    if (isAbsolute(entry)) {
      if (contains(platform, entry, target)) return { kind: "sensitive", root: entry };
    } else if (nameMatches(entry, name)) {
      return { kind: "sensitive", root: entry };
    }
  }

  // A scratch root is disposable and explicitly registered, so it sits between the lists that
  // always win and the user's workspace. Protected and sensitive paths are decided first: a
  // key or the registration itself is not allowed just because it was copied into scratch.
  for (const root of policy.scratch_roots || []) {
    if (contains(platform, root, target)) return { kind: "scratch", root };
  }
  for (const root of policy.workspace_roots || []) {
    if (contains(platform, root, target)) return { kind: "workspace", root };
  }
  return { kind: "outside", root: null };
}

// A missing or unreadable policy is not "no restrictions": it is the state in which full
// access cannot be granted at all (design 2.6.2, regression 18).
export function effectiveTier({ configured = "standard", policy, window = null, now = Date.now() } = {}) {
  if (!TIERS.includes(configured)) throw accessError("ACCESS_TIER_INVALID");
  if (configured !== "full") return { tier: configured, reason: "configured" };
  if (!policy) return { tier: "standard", reason: "policy-missing" };
  if (policy.kill_switch) return { tier: "standard", reason: "kill-switch" };
  const mode = policy.full_access?.mode;
  if (mode === "persistent") return { tier: "full", reason: "persistent" };
  if (mode === "window" && windowIsOpen(window, now)) return { tier: "full", reason: "window" };
  return { tier: "standard", reason: mode === "window" ? "window-closed" : "policy-denied" };
}

// Only the state the issuer writes counts. A spent or unknown record is not evidence that a
// window is still open, and neither is an end that cannot be read.
export function windowIsOpen(window, now = Date.now()) {
  if (!window || window.state !== "open") return false;
  const expires = Date.parse(window.expires_at);
  return Number.isFinite(expires) && expires > now;
}
