import * as win32Process from "./win32/process.mjs";
import * as posixProcess from "./posix/process.mjs";
import * as win32Paths from "./win32/paths.mjs";
import * as win32Service from "./win32/service.mjs";
import { installPolicy as installWin32Policy } from "./win32/policy-install.mjs";
import { installPolicy as installPosixPolicy } from "./posix/policy-install.mjs";
import { createPosixPaths } from "./posix/paths.mjs";
import { createCredentialStore as createWin32CredentialStore } from "./win32/secrets.mjs";
import { createCredentialStore as createLinuxCredentialStore } from "./linux/secrets.mjs";
import { createCredentialStore as createDarwinCredentialStore } from "./darwin/secrets.mjs";
import * as win32Launcher from "./win32/launcher.mjs";
import * as win32Task from "./win32/task.mjs";
import { RUNTIME_KEY_ENVIRONMENT_VARIABLE } from "../runtime/env.mjs";

function platformError(code) {
  return Object.assign(new Error(code), { code });
}

// Linux and macOS share the POSIX process implementation; the only difference is whether
// /proc exists, which that adapter detects once at load time.
const processAdapters = { win32: win32Process, linux: posixProcess, darwin: posixProcess };

// Only Windows implements the service adapter. The unit name on systemd and the label on
// launchd are decided by the launcher step (design 2.10), which does not exist on those
// systems yet, and a guessed name would report someone else's service as ours. Those
// platforms therefore fail explicitly (design 2.8) instead of answering from a convention
// this code does not own.
const serviceAdapters = { win32: win32Service };

// The launcher and its scheduled task are Windows-only for now: the POSIX units are a later
// step (design 2.10), and guessing a unit name here would start the wrong service. Setup asks
// for these adapters and reports an unsupported result instead of writing a partial install.
const launcherAdapters = { win32: win32Launcher };
const taskAdapters = { win32: win32Task };

export function launcherAdapter(platform = process.platform) {
  const adapter = launcherAdapters[platform];
  if (!adapter) throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  return adapter;
}

export function taskAdapter(platform = process.platform) {
  const adapter = taskAdapters[platform];
  if (!adapter) throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  return adapter;
}

export const TASK_NAME = win32Task.TASK_NAME;

const pathsFactories = {
  win32: () => win32Paths,
  linux: () => createPosixPaths("linux"),
  darwin: () => createPosixPaths("darwin"),
};

const pathsCache = new Map();

// The core never branches on the OS name. It asks for an adapter and fails loudly when
// the platform has none: a silent fallback would look like "no processes found" or would
// write configuration to a guessed location.
export function processAdapter(platform = process.platform) {
  const adapter = processAdapters[platform];
  if (!adapter) throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  return adapter;
}

// The service definition is read here and never written: changing what starts the MCP is a
// local elevated step (design 2.10), so the remote side only asks what is registered.
export function serviceAdapter(platform = process.platform) {
  const adapter = serviceAdapters[platform];
  if (!adapter) throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  return adapter;
}

// Installing the registration is an elevated, local step (design 2.6.2). The selector exists
// so the caller does not branch on the OS, and so a system without an installer fails loudly
// instead of writing a registration to a guessed location.
const policyInstallers = { win32: installWin32Policy, linux: installPosixPolicy, darwin: installPosixPolicy };

export function installPolicy(options = {}) {
  const installer = policyInstallers[options.platform ?? process.platform];
  if (!installer) throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  return installer(options);
}

export function pathsAdapter(platform = process.platform) {
  if (!pathsCache.has(platform)) {
    const build = pathsFactories[platform];
    if (!build) throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
    pathsCache.set(platform, build());
  }
  return pathsCache.get(platform);
}

const platformNames = { win32: "Windows", linux: "Linux", darwin: "macOS" };

// Health output is read by a person, so it names the system instead of repeating the
// Node.js identifier. An unknown platform keeps its own name rather than claiming Windows.
export function platformName(platform = process.platform) {
  return platformNames[platform] ?? platform;
}

// Callers that simulate another platform (the Windows launcher scenarios) pass the
// platform they are simulating, so the adapter follows the same platform the rest of
// their code path uses instead of leaking the host.
export function normalizeExecutablePath(value, platform = process.platform) {
  return processAdapter(platform).normalizeExecutablePath(value);
}

export function terminateProcessTree(pid, options, platform = process.platform) {
  return processAdapter(platform).terminateProcessTree(pid, options);
}

// Process-group operations exist only on POSIX. Asking a platform without them fails
// loudly instead of falling back to a PID-only kill that would leave the MCP behind.
export function probeProcessGroup(pgid, options, platform = process.platform) {
  const adapter = processAdapter(platform);
  if (typeof adapter.probeProcessGroup !== "function") throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  return adapter.probeProcessGroup(pgid, options);
}

export function terminateProcessGroup(pgid, options, platform = process.platform) {
  const adapter = processAdapter(platform);
  if (typeof adapter.terminateProcessGroup !== "function") throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  return adapter.terminateProcessGroup(pgid, options);
}

export function probeProcessCommand(pid, options, platform = process.platform) {
  const adapter = processAdapter(platform);
  if (typeof adapter.probeProcessCommand !== "function") throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  return adapter.probeProcessCommand(pid, options);
}

export function caseFold(value) {
  return pathsAdapter().caseFold(value);
}

export function comparisonKey(value) {
  return pathsAdapter().comparisonKey(value);
}

export function samePath(left, right) {
  return pathsAdapter().samePath(left, right);
}

// The policy file is the registration itself (design 2.6.1), so the core asks for its
// location and for a validated read rather than building a path of its own. One
// implementation covers every platform because only the location differs, and that is held
// as data inside the module.
export { POLICY_FILE_NAME, assertProtectedPolicy, parsePolicy, policyFile, readPolicy } from "./policy.mjs";

// The runtime key is a secret and every supported system keeps it somewhere else:
// Credential Manager on Windows, the login keychain on macOS, the Secret Service on
// Linux. The backends are separate files because the tools, the failure codes and the
// way the value can be handed over safely differ completely.
const secretsBackends = {
  win32: { id: "windows-credential-manager", create: createWin32CredentialStore },
  linux: { id: "secret-service", create: createLinuxCredentialStore },
  darwin: { id: "macos-keychain", create: createDarwinCredentialStore },
};

// Escape hatch for systems with no usable store (a headless Linux host has no session
// bus) and for operators who keep the key in their own secret manager. It is read by
// this adapter rather than by each backend so the precedence is the same everywhere.
// The name is owned by the runtime env module so the tunnel/MCP boundaries can remove it.
export { RUNTIME_KEY_ENVIRONMENT_VARIABLE };

export function createCredentialStore({ platform = process.platform, env = process.env, ...options } = {}) {
  const backend = secretsBackends[platform];
  if (!backend) throw platformError("REMOTE_PLATFORM_UNSUPPORTED");
  const native = backend.create({ platform, env, ...options });

  function fromEnvironment() {
    const value = env?.[RUNTIME_KEY_ENVIRONMENT_VARIABLE];
    return typeof value === "string" && value ? value : undefined;
  }

  return {
    // Names whichever source will actually answer, so diagnostics never claim the
    // platform store holds a key that only the environment provides.
    get backend() {
      return fromEnvironment() !== undefined ? "environment" : backend.id;
    },
    async has() {
      if (fromEnvironment() !== undefined) return true;
      return await native.has();
    },
    // The override is not written back to the platform store: a per invocation
    // environment value must not silently become a permanent registration.
    set: secret => native.set(secret),
    async get() {
      const override = fromEnvironment();
      if (override !== undefined) return { state: "registered", secret: override };
      return await native.get();
    },
    // Uninstall must remove the stored item even when this process also received a temporary
    // override: the override is not persisted, so it is not what the store is asked to erase.
    delete: target => native.delete(target),
  };
}
