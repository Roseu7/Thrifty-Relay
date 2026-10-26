import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigPath } from "../i18n/index.mjs";
import { pathsAdapter, createCredentialStore, policyFile, readPolicy, serviceAdapter } from "../platform/index.mjs";
import { readRuntimeState, runtimeStateFile } from "../runtime/state.mjs";
import { probeListeningProcessIds } from "../runtime/listener.mjs";
import { KNOWN_TASK_NAMES, validateTaskSnapshot } from "../../scripts/mcp-control.mjs";

const TASK_NAME = "ThriftyRelay MCP";
const MODES = new Set(["on-login-task", "on-demand-task", "foreground", "manual"]);

const MESSAGE_KEYS = {
  ENV_NODE_UNSUPPORTED: "doctor.environment.nodeUnsupported",
  ENV_SDK_MISSING: "doctor.environment.sdkMissing",
  ENV_NATIVE_BINARY_MISSING: "doctor.environment.binaryMissing",
  ENV_NODE_RECOMMENDED: "doctor.environment.nodeRecommended",
  ENV_READY: "doctor.environment.ready",
  ENV_POSIX_READY: "doctor.environment.posixReady",
  CONFIG_NOT_INSTALLED: "doctor.config.notInstalled",
  CONFIG_INVALID: "doctor.config.invalid",
  CONFIG_UNAVAILABLE: "doctor.config.unavailable",
  CONFIG_MODE_INVALID: "doctor.config.modeInvalid",
  CONFIG_INCOMPLETE: "doctor.config.incomplete",
  CONFIG_READY: "doctor.config.ready",
  CREDENTIAL_REGISTERED: "doctor.credentials.registered",
  CREDENTIAL_UNCONFIGURED: "doctor.credentials.unconfigured",
  CREDENTIAL_BACKEND_ERROR: "doctor.credentials.backendError",
  STARTUP_FOREGROUND_CONFIGURED: "doctor.startup.foreground",
  STARTUP_TASK_REGISTERED: "doctor.startup.taskRegistered",
  STARTUP_TASK_MISSING: "doctor.startup.taskMissing",
  STARTUP_TASK_QUERY_FAILED: "doctor.startup.taskUnknown",
  STARTUP_TASK_INVALID: "doctor.startup.taskInvalid",
  STARTUP_TASK_DISCOVERED: "doctor.startup.taskDiscovered",
  STARTUP_NOT_CONFIGURED: "doctor.startup.notConfigured",
  STARTUP_CONFIG_UNKNOWN: "doctor.startup.configUnknown",
  STARTUP_MANUAL: "doctor.startup.manual",
  RUNTIME_RUNNING: "doctor.readiness.runtimeRunning",
  RUNTIME_IN_TRANSITION: "doctor.readiness.runtimeTransition",
  RUNTIME_FAILED: "doctor.readiness.runtimeFailed",
  RUNTIME_STATE_STALE: "doctor.readiness.runtimeStateStale",
  RUNTIME_OWNER_UNKNOWN: "doctor.readiness.ownerUnknown",
  RUNTIME_OWNER_MISMATCH: "doctor.readiness.ownerMismatch",
  RUNTIME_DEPENDENCY_MISSING: "doctor.readiness.dependencyMissing",
  POLICY_REGISTERED: "doctor.policy.registered",
  POLICY_UNREGISTERED: "doctor.policy.unregistered",
  POLICY_UNVERIFIED: "doctor.policy.unverified",
  STOPPED_IDLE: "doctor.readiness.stoppedIdle",
  LOCAL_ENDPOINT_UNVERIFIED: "doctor.readiness.endpointUnverified",
  LOCAL_RUNTIME_STOPPED: "doctor.readiness.runtimeStopped",
  LOCAL_READINESS_UNKNOWN: "doctor.readiness.unknown",
  READINESS_NOT_CONFIGURED: "doctor.readiness.notConfigured",
};

const CODEX_TARGETS = {
  win32: {
    x64: ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
    arm64: ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"],
  },
  darwin: {
    x64: ["@openai/codex-darwin-x64", "x86_64-apple-darwin", "codex"],
    arm64: ["@openai/codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
  },
  linux: {
    x64: ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
    arm64: ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
  },
};

function check(id, status, code, evidence) {
  return {
    id,
    status,
    code,
    messageKey: MESSAGE_KEYS[code] || "doctor.message.unknown",
    ...(evidence ? { evidence } : {}),
  };
}

function safeTaskNames(taskNames) {
  if (!Array.isArray(taskNames) || taskNames.length === 0 ||
      taskNames.some(name => !KNOWN_TASK_NAMES.includes(name))) return null;
  return [...new Set(taskNames)];
}

// The definition is read through the platform adapter: what starts the MCP is registered
// differently on every system, and a host whose backend is missing reports an unknown
// startup rather than an empty one.
export async function readScheduledTasks({ taskNames = KNOWN_TASK_NAMES, platform = process.platform, run } = {}) {
  const names = safeTaskNames(taskNames);
  if (!names) return { ok: false, code: "STARTUP_TASK_QUERY_FAILED" };

  try {
    return { ok: true, tasks: await serviceAdapter(platform).readStartupDefinitions({ names, run }) };
  } catch {
    return { ok: false, code: "STARTUP_TASK_QUERY_FAILED" };
  }
}

export async function probeLoopback({ url = "http://127.0.0.1:8080/readyz", fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return { state: "unknown" }; }
  if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1" || parsedUrl.pathname !== "/readyz" || !fetchImpl) {
    return { state: "unknown" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(parsedUrl, { method: "GET", redirect: "manual", signal: controller.signal });
    try { await response?.body?.cancel?.(); } catch {}
    return { state: "responding", httpStatus: Number.isInteger(response?.status) ? response.status : null };
  } catch (error) {
    const code = error?.cause?.code || error?.code;
    if (code === "ECONNREFUSED") return { state: "stopped" };
    return { state: "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveInstalledRuntime({ platform, arch }) {
  let sdkResolved = false;
  let nativeBinaryAvailable = false;
  try {
    import.meta.resolve("@openai/codex-sdk");
    sdkResolved = true;
  } catch {}
  const target = CODEX_TARGETS[platform]?.[arch];
  if (target) {
    try {
      const packageJson = fileURLToPath(import.meta.resolve(`${target[0]}/package.json`));
      const binary = path.join(path.dirname(packageJson), "vendor", target[1], "bin", target[2]);
      await fs.access(binary);
      nativeBinaryAvailable = true;
    } catch {}
  }
  return { sdkResolved, nativeBinaryAvailable };
}

async function inspectEnvironment({ platform, arch = process.arch, nodeVersion = process.version, resolveInstalledRuntime: runtimeResolver = resolveInstalledRuntime }) {
  const nodeMajor = Number(String(nodeVersion).match(/^v?(\d+)/)?.[1] || 0);
  let runtime = { sdkResolved: false, nativeBinaryAvailable: false };
  try { runtime = await runtimeResolver({ platform, arch }); } catch {}
  const evidence = {
    ...(nodeMajor ? { nodeMajor } : {}),
    sdkResolved: runtime.sdkResolved === true,
    nativeBinaryAvailable: runtime.nativeBinaryAvailable === true,
  };
  if (nodeMajor < 18) return check("environment", "FAIL", "ENV_NODE_UNSUPPORTED", evidence);
  if (!evidence.sdkResolved) return check("environment", "FAIL", "ENV_SDK_MISSING", evidence);
  if (!evidence.nativeBinaryAvailable) return check("environment", "FAIL", "ENV_NATIVE_BINARY_MISSING", evidence);
  if (nodeMajor < 22) return check("environment", "WARN", "ENV_NODE_RECOMMENDED", evidence);
  return check("environment", "PASS", platform === "win32" ? "ENV_READY" : "ENV_POSIX_READY", evidence);
}

async function readConfig(configPath, readFile, platform) {
  let source;
  try { source = await readFile(configPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" };
    return { state: "unavailable" };
  }
  let value;
  try { value = JSON.parse(String(source).replace(/^\uFEFF/, "")); }
  catch { return { state: "invalid" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "invalid" };
  if (!Object.hasOwn(value, "mode")) return { state: "unconfigured" };
  if (typeof value.mode !== "string" || !MODES.has(value.mode) ||
      (platform === "win32" ? value.mode === "manual" : value.mode !== "manual")) {
    return { state: "invalid-mode" };
  }
  if (Object.hasOwn(value, "taskName") && !KNOWN_TASK_NAMES.includes(value.taskName)) return { state: "invalid" };
  const workspaceAbsolute = typeof value.workspace === "string" &&
    pathsAdapter(platform).isAbsolute(value.workspace);
  if (!workspaceAbsolute) return { state: "incomplete", mode: value.mode };
  const taskName = KNOWN_TASK_NAMES.includes(value.taskName) ? value.taskName : TASK_NAME;
  return { state: "configured", mode: value.mode, taskName };
}

function classifyConfig(result) {
  if (result.state === "missing" || result.state === "unconfigured") {
    return check("config", "UNKNOWN", "CONFIG_NOT_INSTALLED");
  }
  if (result.state === "invalid") return check("config", "FAIL", "CONFIG_INVALID");
  if (result.state === "unavailable") return check("config", "UNKNOWN", "CONFIG_UNAVAILABLE");
  if (result.state === "invalid-mode") return check("config", "FAIL", "CONFIG_MODE_INVALID");
  if (result.state === "incomplete") return check("config", "FAIL", "CONFIG_INCOMPLETE", { mode: result.mode });
  return check("config", "PASS", "CONFIG_READY", { mode: result.mode, workspaceAbsolute: true });
}

async function inspectStartup(config, readTasks, platform, runPowerShell) {
  if (config.state === "invalid" || config.state === "unavailable" || config.state === "invalid-mode") {
    return { check: check("startup", "UNKNOWN", "STARTUP_CONFIG_UNKNOWN"), mode: config.mode };
  }
  if (config.mode === "manual") {
    return { check: check("startup", "PASS", "STARTUP_MANUAL", { mode: "manual" }), mode: config.mode };
  }
  if (config.mode === "foreground") {
    return { check: check("startup", "PASS", "STARTUP_FOREGROUND_CONFIGURED", { mode: "foreground" }), mode: config.mode };
  }

  const configured = config.mode === "on-login-task" || config.mode === "on-demand-task";
  const taskNames = configured ? [config.taskName || TASK_NAME] : KNOWN_TASK_NAMES;
  let result;
  try { result = await readTasks({ taskNames, platform, run: runPowerShell }); }
  catch { result = { ok: false }; }
  if (!result?.ok || !Array.isArray(result.tasks)) {
    return { check: check("startup", "UNKNOWN", "STARTUP_TASK_QUERY_FAILED"), mode: config.mode };
  }

  if (!configured) {
    if (result.tasks.length === 0) {
      return { check: check("startup", "UNKNOWN", "STARTUP_NOT_CONFIGURED"), mode: null };
    }
    return {
      check: check("startup", "WARN", "STARTUP_TASK_DISCOVERED", {
        taskCount: result.tasks.length,
        ...(result.tasks.length === 1 ? { state: result.tasks[0].state } : {}),
      }),
      mode: null,
    };
  }

  const taskName = config.taskName || TASK_NAME;
  const task = result.tasks.find(row => row.name === taskName);
  if (!task) return { check: check("startup", "FAIL", "STARTUP_TASK_MISSING", { mode: config.mode }), mode: config.mode };
  const validation = validateTaskSnapshot({ task });
  if (!validation.ok) return { check: check("startup", "FAIL", "STARTUP_TASK_INVALID", { mode: config.mode }), mode: config.mode };
  return {
    check: check("startup", "PASS", "STARTUP_TASK_REGISTERED", { mode: config.mode, state: task.state }),
    mode: config.mode,
    taskState: task.state,
  };
}

async function inspectPolicy({ platform, env, policyReader }) {
  let registered = false;
  try {
    await policyReader(policyFile({ platform, env }), platform);
    registered = true;
  } catch (error) {
    // An unregistered host is the documented legacy state, not a broken install.
    if (error?.code === "POLICY_MISSING") {
      return check("policy", "WARN", "POLICY_UNREGISTERED", { registered: false });
    }
    return check("policy", "WARN", "POLICY_UNVERIFIED", { registered: false });
  }
  return check("policy", "PASS", "POLICY_REGISTERED", { registered });
}

async function inspectCredentials(credentialStore) {
  const backend = credentialStore?.backend ?? "unspecified";
  try {
    const registered = await credentialStore.has();
    return registered
      ? check("credentials", "PASS", "CREDENTIAL_REGISTERED", { backend, registered: true })
      : check("credentials", "FAIL", "CREDENTIAL_UNCONFIGURED", { backend, registered: false });
  } catch {
    return check("credentials", "UNKNOWN", "CREDENTIAL_BACKEND_ERROR", { backend });
  }
}

function classifyReadiness(config, startup, probe, runtimeState = null, ownerPids = null) {
  if (runtimeState === "unavailable") {
    return check("readiness", "UNKNOWN", "LOCAL_READINESS_UNKNOWN", { state: "unknown", ready: false });
  }
  if (runtimeState?.state) {
    if (runtimeState.state === "running") {
      if (probe?.state === "responding" && runtimeState.ownerVerified === true) {
        if (ownerPids === "dependency-missing") {
          return check("readiness", "UNKNOWN", "RUNTIME_DEPENDENCY_MISSING", {
            state: "running", ready: false, ownerVerified: false,
          });
        }
        if (ownerPids === "unknown" || !Array.isArray(ownerPids)) {
          return check("readiness", "UNKNOWN", "RUNTIME_OWNER_UNKNOWN", {
            state: "running", ready: false, ownerVerified: false,
          });
        }
        if (!ownerPids.includes(runtimeState.tunnelPid)) {
          return check("readiness", "FAIL", "RUNTIME_OWNER_MISMATCH", {
            state: "running", ready: false, ownerVerified: false,
          });
        }
        return check("readiness", "PASS", "RUNTIME_RUNNING", {
          state: "running", ready: true, pid: runtimeState.tunnelPid, ownerVerified: true,
        });
      }
      if (probe?.state === "stopped") {
        return check("readiness", "FAIL", "RUNTIME_STATE_STALE", { state: "running", ready: false });
      }
      return check("readiness", "UNKNOWN", "LOCAL_READINESS_UNKNOWN", { state: "running", ready: false });
    }
    if (runtimeState.state === "starting" || runtimeState.state === "stopping") {
      return check("readiness", "UNKNOWN", "RUNTIME_IN_TRANSITION", {
        state: runtimeState.state, ready: false,
      });
    }
    if (runtimeState.state === "failed") {
      return check("readiness", "FAIL", "RUNTIME_FAILED", {
        state: "failed", ready: false,
        ...(runtimeState.errorCode ? { errorCode: runtimeState.errorCode } : {}),
      });
    }
    if (probe?.state === "stopped") {
      return check("readiness", "PASS", "STOPPED_IDLE", { state: "stopped", ready: false });
    }
  }
  if (probe?.state === "responding") {
    return check("readiness", "UNKNOWN", "LOCAL_ENDPOINT_UNVERIFIED", {
      state: "responding",
      ...(Number.isInteger(probe.httpStatus) ? { httpStatus: probe.httpStatus } : {}),
      ready: false,
    });
  }
  if (config.state !== "configured") {
    return check("readiness", "UNKNOWN", "READINESS_NOT_CONFIGURED", { state: "unknown", ready: false });
  }
  if (probe?.state !== "stopped") return check("readiness", "UNKNOWN", "LOCAL_READINESS_UNKNOWN", { state: "unknown", ready: false });
  if (config.mode === "foreground" || config.mode === "manual") {
    return check("readiness", "PASS", "STOPPED_IDLE", { state: "stopped", ready: false });
  }
  if (startup?.check.status !== "PASS") {
    return check("readiness", "UNKNOWN", "LOCAL_READINESS_UNKNOWN", { state: "unknown", ready: false });
  }
  if (config.mode === "on-demand-task" && startup.taskState === "Ready") {
    return check("readiness", "PASS", "STOPPED_IDLE", { state: "stopped", ready: false });
  }
  return check("readiness", "FAIL", "LOCAL_RUNTIME_STOPPED", { state: "stopped", ready: false });
}

export async function collectDoctorChecks({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  nodeVersion = process.version,
  readFile = fs.readFile,
  resolveInstalledRuntime: runtimeResolver = resolveInstalledRuntime,
  readTasks = readScheduledTasks,
  runPowerShell,
  probeReadiness = probeLoopback,
  probeOwners = port => probeListeningProcessIds(port, { platform }),
  policyReader = readPolicy,
  credentialStore = createCredentialStore({ platform, env }),
} = {}) {
  const configPath = getConfigPath({ env, platform, home });
  const [environment, config] = await Promise.all([
    inspectEnvironment({ platform, arch, nodeVersion, resolveInstalledRuntime: runtimeResolver }),
    readConfig(configPath, readFile, platform),
  ]);
  const startup = await inspectStartup(config, readTasks, platform, runPowerShell);
  let runtimeState = null;
  if (platform !== "win32" && config.state === "configured" && config.mode === "manual") {
    try {
      const stateFile = runtimeStateFile({ platform, env, home });
      await fs.access(path.posix.dirname(stateFile));
      runtimeState = await readRuntimeState(stateFile);
    } catch (error) {
      runtimeState = error?.code === "ENOENT" ? null : "unavailable";
    }
  }
  let probe;
  try { probe = await probeReadiness(); } catch { probe = { state: "unknown" }; }
  let ownerPids = null;
  if (runtimeState?.state === "running" && probe?.state === "responding") {
    try { ownerPids = await probeOwners(runtimeState.port); }
    catch (error) {
      ownerPids = error?.code === "RUNTIME_DEPENDENCY_MISSING" ? "dependency-missing" : "unknown";
    }
  }
  const [credentials, policy] = await Promise.all([
    inspectCredentials(credentialStore),
    inspectPolicy({ platform, env, policyReader }),
  ]);
  return [
    environment,
    classifyConfig(config),
    credentials,
    startup.check,
    classifyReadiness(config, startup, probe, runtimeState, ownerPids),
    policy,
  ];
}

export function publicDoctorChecks(checks) {
  return checks.map(({ id, status, code, evidence }) => ({
    id,
    status,
    code,
    ...(evidence ? { evidence } : {}),
  }));
}

export function doctorMessageKey(code) {
  return MESSAGE_KEYS[code] || "doctor.message.unknown";
}
