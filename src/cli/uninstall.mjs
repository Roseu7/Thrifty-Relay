import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { translate } from "../i18n/index.mjs";
import { readSetupConfig } from "../config.mjs";
import {
  createCredentialStore,
  launcherAdapter,
  pathsAdapter,
  serviceAdapter,
  taskAdapter,
  TASK_NAME,
} from "../platform/index.mjs";
import { STATE_FILE_NAME, runtimeDirectory, runtimeStateFile } from "../runtime/state.mjs";
import { LOG_FILE_NAME, LOG_ROTATED_NAME } from "../runtime/log.mjs";
import { LOCK_DIRECTORY, RECLAIM_DIRECTORY } from "../runtime/lock.mjs";
import { stopBackgroundRuntime } from "../runtime/background.mjs";
import { stopTaskRuntime } from "../runtime/task-control.mjs";
import { probeLoopback } from "./doctor.mjs";

const RUNTIME_FILES = [STATE_FILE_NAME, LOG_FILE_NAME, LOG_ROTATED_NAME];
const RUNTIME_DIRECTORIES = [LOCK_DIRECTORY, RECLAIM_DIRECTORY];

function uninstallError(code, cause) {
  const error = Object.assign(new Error(code), { code });
  if (cause !== undefined) {
    error.cause = cause;
    if (typeof cause?.code === "string" && /^[A-Z0-9_]+$/.test(cause.code)) error.detailCode = cause.code;
  }
  return error;
}

function errorMessage(language, code) {
  const key = `uninstall.error.${code}`;
  const message = translate(language, key);
  return message === key ? translate(language, "uninstall.error.generic") : message;
}

// The plan is read-only. It resolves the locations from the same adapters setup used, so an
// overridden config file removes that file and not some guessed default, and a PATH-less
// Windows host reports no launcher instead of constructing one from an empty variable.
export async function planUninstall({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  configFile,
  configReader = readSetupConfig,
} = {}) {
  const paths = pathsAdapter(platform);
  const dirname = platform === "win32" ? path.win32.dirname : path.posix.dirname;
  const defaultConfig = paths.configFile({ env, home });
  const targetConfig = configFile ?? defaultConfig;
  let config = {};
  let configError = null;
  try {
    config = await configReader(targetConfig, { platform });
  } catch (error) {
    configError = error?.code || "CONFIG_INVALID";
  }

  const taskStore = typeof config.taskDirectory === "string" && paths.isAbsolute(config.taskDirectory)
    ? config.taskDirectory
    : paths.taskDirectory({ env, home });

  let launcher = null;
  let launcherLog = null;
  if (platform === "win32") {
    try {
      const adapter = launcherAdapter(platform);
      launcher = adapter.launcherPath({ env });
      launcherLog = adapter.launcherLogPath({ env });
    } catch {
      // A missing LOCALAPPDATA means there is no launcher to remove. Keep the plan usable.
    }
  }

  let stateDirectory = null;
  let stateFile = null;
  if (platform !== "win32") {
    try {
      stateDirectory = runtimeDirectory({ platform, env, home });
      stateFile = runtimeStateFile({ platform, env, home });
    } catch {
      // An invalid home leaves no state directory to clean; the other steps still apply.
    }
  }

  return {
    platform,
    env,
    home,
    config,
    configError,
    configFile: targetConfig,
    configDirectory: paths.samePath(targetConfig, defaultConfig) ? dirname(defaultConfig) : null,
    taskStore,
    launcher,
    launcherDirectory: launcher ? dirname(launcher) : null,
    launcherLog,
    launcherLogDirectory: launcherLog ? dirname(launcherLog) : null,
    stateDirectory,
    stateFile,
  };
}

async function removeFile(file, unlink) {
  try {
    await unlink(file);
    return "removed";
  } catch (error) {
    return error?.code === "ENOENT" ? "absent" : "failed";
  }
}

async function removeEmptyDirectory(directory, rmdir) {
  try {
    await rmdir(directory);
    return "removed";
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    // Non-empty means somebody else's file lives here. Leave the directory in place.
    if (["ENOTEMPTY", "EEXIST", "EPERM", "EBUSY", "ENOTDIR"].includes(error?.code)) return "kept";
    return "failed";
  }
}

async function stopRuntime(plan, {
  readTasks,
  stopTask,
  stopTaskOnly,
  stopBackground,
  probeReadiness,
}) {
  if (plan.platform === "win32") {
    let tasks;
    try {
      tasks = await readTasks({ names: [TASK_NAME], platform: plan.platform });
    } catch (error) {
      throw uninstallError("UNINSTALL_TASK_QUERY_FAILED", error);
    }
    const task = tasks.find(item => item.name === TASK_NAME);
    const taskExists = Boolean(task);

    // A task that is not running must not send us into the owner-killing path: a retained
    // unrelated tunnel can use the same tunnel-client executable and own port 8080.
    if (taskExists && task.state !== "Running" && task.state !== "Ready") {
      throw uninstallError("UNINSTALL_RUNTIME_STOP_UNCONFIRMED");
    }
    if (task?.state === "Running") {
      if (typeof plan.config.tunnelClientPath === "string" && plan.config.tunnelClientPath) {
        let stopped;
        try {
          stopped = await stopTask({
            config: plan.config,
            name: TASK_NAME,
            platform: plan.platform,
            env: plan.env,
          });
        } catch (error) {
          throw uninstallError("UNINSTALL_RUNTIME_STOP_FAILED", error);
        }
        if (!stopped?.ok) throw uninstallError("UNINSTALL_RUNTIME_STOP_FAILED", { code: stopped?.code });
      } else {
        // Without the saved tunnel path the launcher tree cannot be verified. Stop the task,
        // then require a stopped loopback endpoint before removing anything.
        try {
          await stopTaskOnly({ name: TASK_NAME });
        } catch (error) {
          throw uninstallError("UNINSTALL_RUNTIME_STOP_FAILED", error);
        }
      }
    }

    // The stopped-state check is independent of the task state and of stopTaskRuntime's
    // listener probe. A failed listener query there becomes an empty owner list, which is not
    // evidence that the tunnel is gone.
    const probe = await probeReadiness();
    if (probe?.state !== "stopped") {
      throw uninstallError(plan.config.mode === "foreground" && probe?.state === "responding"
        ? "UNINSTALL_FOREGROUND_RUNNING" : "UNINSTALL_RUNTIME_STOP_UNCONFIRMED");
    }
    return { taskExists, wasRunning: task?.state === "Running" };
  }

  let stopped;
  try {
    stopped = await stopBackground({
      stateFile: plan.stateFile,
      platform: plan.platform,
      env: plan.env,
      home: plan.home,
    });
  } catch (error) {
    throw uninstallError("UNINSTALL_RUNTIME_STOP_FAILED", error);
  }
  if (!stopped?.ok) throw uninstallError("UNINSTALL_RUNTIME_STOP_FAILED", { code: stopped?.code });
  // A replacement runtime can start while the old supervisor is stopping. Its state and
  // credential must not be removed by this uninstall.
  if (stopped.record === "replaced") throw uninstallError("UNINSTALL_RUNTIME_REPLACED");
  return { taskExists: false, wasRunning: stopped.stopped === true };
}

function failedResult(plan, language, code, error, actions = []) {
  return {
    ok: false,
    code,
    detailCode: error?.detailCode,
    language,
    message: errorMessage(language, code),
    actions,
    preserved: preservedItems(plan),
  };
}

function preservedItems(plan) {
  return [
    { id: "taskStore", path: plan.taskStore },
    { id: "codexAuth" },
    { id: "policy" },
  ];
}

// Execution is deliberately ordered so a running runtime or a still-registered task stops the
// uninstall before the credential and configuration it depends on are removed. File cleanup
// runs last and reports each failure instead of hiding a partially removed installation.
export async function executeUninstall(plan, {
  language = "en",
  backgroundStopper = stopBackgroundRuntime,
  taskStopper = options => stopTaskRuntime(options),
  taskStopperOnly = options => taskAdapter(plan.platform).stopTask(options),
  taskRemover = options => taskAdapter(plan.platform).removeTask(options),
  taskReader = options => serviceAdapter(plan.platform).readStartupDefinitions(options),
  credentialStore = createCredentialStore({ platform: plan.platform, env: plan.env }),
  probeReadiness = probeLoopback,
  unlink = fs.unlink,
  rmdir = fs.rmdir,
} = {}) {
  let stopped;
  try {
    stopped = await stopRuntime(plan, {
      readTasks: taskReader,
      stopTask: taskStopper,
      stopTaskOnly: taskStopperOnly,
      stopBackground: backgroundStopper,
      probeReadiness,
    });
  } catch (error) {
    return failedResult(plan, language, error?.code || "UNINSTALL_RUNTIME_STOP_FAILED", error,
      [{ id: "runtime", status: "failed" }]);
  }

  const actions = [{ id: "runtime", status: stopped.wasRunning ? "stopped" : "alreadyStopped" }];

  if (plan.platform === "win32" && stopped.taskExists) {
    try {
      const removed = await taskRemover({ name: TASK_NAME });
      actions.push({ id: "task", status: removed?.removed ? "removed" : "absent" });
    } catch (error) {
      return failedResult(plan, language, "UNINSTALL_TASK_REMOVE_FAILED", error,
        [...actions, { id: "task", status: "failed" }]);
    }
  } else if (plan.platform === "win32") {
    actions.push({ id: "task", status: "absent" });
  }

  let credentialStatus;
  try {
    credentialStatus = await credentialStore.delete() ? "removed" : "absent";
  } catch (error) {
    return failedResult(plan, language, "UNINSTALL_CREDENTIAL_DELETE_FAILED", error,
      [...actions, { id: "credentials", status: "failed" }]);
  }
  actions.push({ id: "credentials", status: credentialStatus });

  actions.push({ id: "config", status: await removeFile(plan.configFile, unlink) });
  if (plan.launcher) actions.push({ id: "launcher", status: await removeFile(plan.launcher, unlink) });
  if (plan.launcherLog) actions.push({ id: "logs", status: await removeFile(plan.launcherLog, unlink) });
  // Remove the child directory before its parent, or the parent still contains logs and is
  // reported as kept even though every file this product owns has just been deleted.
  if (plan.launcherLogDirectory) {
    actions.push({ id: "logDirectory", status: await removeEmptyDirectory(plan.launcherLogDirectory, rmdir) });
  }
  if (plan.launcherDirectory) {
    actions.push({ id: "launcherDirectory", status: await removeEmptyDirectory(plan.launcherDirectory, rmdir) });
  }

  if (plan.stateDirectory) {
    let stateStatus = "absent";
    for (const name of RUNTIME_FILES) {
      const status = await removeFile(path.posix.join(plan.stateDirectory, name), unlink);
      if (status === "failed") stateStatus = "failed";
      else if (status === "removed" && stateStatus !== "failed") stateStatus = "removed";
    }
    for (const name of RUNTIME_DIRECTORIES) {
      const status = await removeEmptyDirectory(path.posix.join(plan.stateDirectory, name), rmdir);
      if (status === "failed") stateStatus = "failed";
      else if (status === "kept" && stateStatus !== "failed") stateStatus = "kept";
      else if (status === "removed" && stateStatus === "absent") stateStatus = "removed";
    }
    const directoryStatus = await removeEmptyDirectory(plan.stateDirectory, rmdir);
    if (directoryStatus === "failed") stateStatus = "failed";
    else if (directoryStatus === "kept" && stateStatus !== "failed") stateStatus = "kept";
    else if (directoryStatus === "removed" && stateStatus === "absent") stateStatus = "removed";
    actions.push({ id: "state", status: stateStatus });
  }

  if (plan.configDirectory) {
    actions.push({ id: "configDirectory", status: await removeEmptyDirectory(plan.configDirectory, rmdir) });
  }

  const failed = actions.some(action => action.status === "failed");
  return {
    ok: !failed,
    code: failed ? "UNINSTALL_INCOMPLETE" : "UNINSTALLED",
    language,
    message: translate(language, failed ? "uninstall.error.UNINSTALL_INCOMPLETE" : "uninstall.success"),
    actions,
    preserved: preservedItems(plan),
  };
}

function planLines(plan, language) {
  const lines = [translate(language, "uninstall.plan.intro")];
  lines.push(`- ${translate(language, "uninstall.plan.runtime")}`);
  if (plan.platform === "win32") {
    lines.push(`- ${translate(language, "uninstall.plan.task", { name: TASK_NAME })}`);
  }
  lines.push(`- ${translate(language, "uninstall.plan.credentials")}`);
  lines.push(`- ${translate(language, "uninstall.plan.config", { path: plan.configFile })}`);
  if (plan.launcher) lines.push(`- ${translate(language, "uninstall.plan.launcher", { path: plan.launcher })}`);
  if (plan.launcherLog) lines.push(`- ${translate(language, "uninstall.plan.logs", { path: plan.launcherLog })}`);
  if (plan.stateDirectory) {
    lines.push(`- ${translate(language, "uninstall.plan.state", { path: plan.stateDirectory })}`);
  }
  lines.push("", ...preservedLines(plan, language));
  return lines;
}

function preservedLines(plan, language) {
  return [translate(language, "uninstall.kept.heading"),
    `- ${translate(language, "uninstall.kept.taskStore", { path: plan.taskStore })}`,
    `- ${translate(language, "uninstall.kept.codexAuth")}`,
    `- ${translate(language, "uninstall.kept.policy")}`];
}

function resultLines(result, language) {
  const lines = [translate(language, "uninstall.result.heading")];
  for (const action of result.actions) {
    if (action.status !== "failed" && (action.status !== "removed" || action.id.endsWith("Directory"))) continue;
    const code = action.status === "failed" ? ` (${result.detailCode || result.code})` : "";
    lines.push(translate(language, "uninstall.result.line", {
      action: translate(language, `uninstall.action.${action.id}`),
      status: translate(language, `uninstall.status.${action.status}`) + code,
    }));
  }
  if (result.ok) lines.push("", result.message);
  return lines;
}

async function confirmUninstall({ stdin, stdout, language }) {
  const prompt = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const answer = (await prompt.question(translate(language, "uninstall.prompt"))).trim().toLowerCase();
    return ["y", "yes"].includes(answer);
  } finally {
    prompt.close();
  }
}

export async function runUninstallCommand({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  configFile,
  language = "en",
  yes = false,
  dryRun = false,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  credentialStore,
  planOptions = {},
  executeOptions = {},
} = {}) {
  let plan;
  try {
    plan = await planUninstall({ platform, env, home, configFile, ...planOptions });
  } catch (error) {
    const code = error?.code || "UNINSTALL_PLAN_FAILED";
    stderr.write(`${code}: ${errorMessage(language, code)}\n`);
    return 1;
  }

  stdout.write(`${translate(language, "uninstall.heading")}\n\n`);
  stdout.write(`${planLines(plan, language).join("\n")}\n\n`);
  if (dryRun) {
    return 0;
  }

  if (!yes) {
    if (!stdin?.isTTY || !stdout?.isTTY) {
      stderr.write(`${translate(language, "uninstall.error.UNINSTALL_CONFIRMATION_REQUIRED")}\n`);
      return 2;
    }
    let confirmed = false;
    try {
      confirmed = await confirmUninstall({ stdin, stdout, language });
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      stdout.write(`${translate(language, "uninstall.cancelled")}\n`);
      return 2;
    }
  }

  let result;
  try {
    result = await executeUninstall(plan, {
      language,
      ...(credentialStore ? { credentialStore } : {}),
      ...executeOptions,
    });
  } catch (error) {
    const code = error?.code || "UNINSTALL_INCOMPLETE";
    stderr.write(`${code}: ${errorMessage(language, code)}\n`);
    return 1;
  }
  stdout.write(`\n${resultLines(result, language).join("\n")}\n`);
  if (!result.ok) {
    stderr.write(`${result.message}\n`);
    return 1;
  }
  return 0;
}
