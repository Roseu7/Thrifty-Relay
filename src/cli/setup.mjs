import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { translate } from "../i18n/index.mjs";
import { readSetupConfig, updateSetupConfig, TUNNEL_ID } from "../config.mjs";
import { startForegroundRuntime } from "../runtime/foreground.mjs";
import { probeReadyEndpoint, waitForReady } from "../runtime/readiness.mjs";
import { stopTaskRuntime } from "../runtime/task-control.mjs";
import { launcherAdapter, taskAdapter, TASK_NAME, pathsAdapter } from "../platform/index.mjs";

const execFileAsync = promisify(execFile);
const TUNNEL_SETUP_URL = "https://platform.openai.com/settings/organization/tunnels";
const TUNNEL_DOWNLOAD_URL = "https://platform.openai.com/settings/organization/tunnels";
const TUNNEL_RUNTIME_KEY_URL = "https://platform.openai.com/settings/organization/api-keys";

// `detail` carries the underlying error code of a failure whose user-facing code is generic.
// Without it, CONFIG_UNAVAILABLE cannot be told apart from a read, a validation, or a write
// failure after the fact.
function result(code, language, values = {}, detail = null) {
  return {
    ok: false, code: `SETUP_${code.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`, language,
    ...(detail ? { detail } : {}),
    message: translate(language, `setup.result.${code}`, values),
  };
}

async function isDirectory(directory) {
  try { return (await fs.stat(directory)).isDirectory(); } catch { return false; }
}

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

// The temporary work area must not be the user's project, the internal task store, or the
// installed package: those are exactly the places cleanup must never be able to reach.
function contains(platform, root, target) {
  const paths = pathsAdapter(platform);
  const separator = platform === "win32" ? path.win32.sep : path.posix.sep;
  const base = paths.comparisonKey(root);
  const value = paths.comparisonKey(target);
  if (value === base) return true;
  return value.startsWith(base.endsWith(separator) ? base : base + separator);
}

// Overlap is a question about the real location, not the spelling. A junction or symlink in an
// existing ancestor would otherwise let a path that actually lives inside the workspace be
// accepted as a separate area and then be created and swept there. Segments that do not exist
// yet are appended to the resolved ancestor, so the answer describes where the bytes would go.
async function realLocation(flavourPath, value, realpath) {
  const start = flavourPath.resolve(value);
  const missing = [];
  let current = start;
  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = await realpath(current);
      return missing.length ? flavourPath.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = flavourPath.dirname(current);
      if (parent === current) return start;
      missing.push(flavourPath.basename(current));
      current = parent;
    }
  }
  throw Object.assign(new Error("TEMP_PATH_TOO_DEEP"), { code: "TEMP_PATH_TOO_DEEP" });
}

export async function prepareTempWorkspace({
  value, platform = process.platform, workspace, taskDirectory, runtimeDirectory, configFile, packageRoot,
  mkdir = fs.mkdir, stat = fs.stat, lstat = fs.lstat, realpath = fs.realpath,
} = {}) {
  const paths = pathsAdapter(platform);
  const flavourPath = platform === "win32" ? path.win32 : path.posix;
  if (typeof value !== "string" || !paths.isAbsolute(value)) return { ok: false, code: "TEMP_ABSOLUTE_REQUIRED" };
  const target = paths.normalize(value);
  let realTarget;
  let realWorkspace;
  let realTasks;
  let realRuntime;
  let realConfig;
  let realPackage;
  try {
    realTarget = await realLocation(flavourPath, target, realpath);
    realWorkspace = workspace ? await realLocation(flavourPath, workspace, realpath) : null;
    realTasks = taskDirectory ? await realLocation(flavourPath, taskDirectory, realpath) : null;
    realRuntime = runtimeDirectory ? await realLocation(flavourPath, runtimeDirectory, realpath) : null;
    realConfig = configFile ? await realLocation(flavourPath, flavourPath.dirname(configFile), realpath) : null;
    realPackage = packageRoot ? await realLocation(flavourPath, packageRoot, realpath) : null;
  } catch {
    // Without the real locations the separation cannot be proven, so nothing is created.
    return { ok: false, code: "TEMP_UNAVAILABLE" };
  }
  if (realWorkspace && (contains(platform, realTarget, realWorkspace) || contains(platform, realWorkspace, realTarget))) {
    return { ok: false, code: "TEMP_OVERLAPS_WORKSPACE" };
  }
  if (realTasks && (contains(platform, realTarget, realTasks) || contains(platform, realTasks, realTarget))) {
    return { ok: false, code: "TEMP_OVERLAPS_TASK_STORE" };
  }
  if (realRuntime && (contains(platform, realTarget, realRuntime) || contains(platform, realRuntime, realTarget))) {
    return { ok: false, code: "TEMP_OVERLAPS_RUNTIME_STATE" };
  }
  if (realConfig && (contains(platform, realTarget, realConfig) || contains(platform, realConfig, realTarget))) {
    return { ok: false, code: "TEMP_OVERLAPS_CONFIG" };
  }
  if (realPackage && (contains(platform, realPackage, realTarget) || contains(platform, realTarget, realPackage))) {
    return { ok: false, code: "TEMP_INSIDE_PACKAGE" };
  }

  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isDirectory()) return { ok: false, code: "TEMP_NOT_DIRECTORY" };
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, code: "TEMP_UNAVAILABLE" };
    try { await mkdir(target, { recursive: true, mode: 0o700 }); }
    catch { return { ok: false, code: "TEMP_UNAVAILABLE" }; }
  }
  const created = await stat(target).catch(() => null);
  if (!created?.isDirectory()) return { ok: false, code: "TEMP_UNAVAILABLE" };
  return { ok: true, path: target };
}

// The launcher lives next to the user's local data, not in the checkout: the task must keep
// working after the repository moves, and mcp-control reads the generated file by this path.
async function installLauncher({ config, platform, env, packageRoot }) {
  const adapter = launcherAdapter(platform);
  const file = adapter.launcherPath({ env });
  // mcp-control normalises separators before matching, so the forward slashes here are safe
  // and match what the previous launcher wrote.
  const mcpCommand = `node ${path.posix.join(String(packageRoot).replaceAll("\\", "/"), "index.mjs")}`;
  const content = adapter.launcherScript({
    tunnel: config.tunnelClientPath,
    tunnelId: config.tunnelId,
    mcpCommand,
    taskDirectory: config.taskDirectory,
    codexWorkspace: config.workspace,
    tempWorkspace: config.tempWorkspace,
  });
  return adapter.writeLauncher({ file, content });
}

async function ensureRuntimeKey({ credentialStore, prompts, language, step }) {
  prompts.write(`${translate(language, "setup.hint.runtimeKey", { url: TUNNEL_RUNTIME_KEY_URL })}\n`);
  const runtimeKey = await prompts.secret(translate(language, "setup.prompt.runtimeKey"));
  if (!runtimeKey) return { ok: false, code: "runtimeKeyRequired" };
  try {
    await step(() => credentialStore.set(runtimeKey));
    return { ok: true };
  } catch (error) {
    if (error?.code === "CREDENTIAL_INPUT_INVALID") return { ok: false, code: "runtimeKeyRequired" };
    return { ok: false, code: "credentialWriteFailed", value: error?.code || "CREDENTIAL_WRITE_FAILED" };
  }
}

export async function findTunnelClient({ platform = process.platform, run = execFileAsync } = {}) {
  const paths = pathsAdapter(platform);
  const { command, args } = paths.executableLookup("tunnel-client");
  try {
    const { stdout } = await run(command, args, { windowsHide: true, timeout: 5000 });
    for (const candidate of String(stdout).split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      if (paths.isAbsolute(candidate) && await isFile(candidate)) return paths.normalize(candidate);
    }
  } catch {}
  return null;
}

export async function runSetup({
  configFile,
  initialLanguage = "en",
  platform = process.platform,
  home = os.homedir(),
  cwd = process.cwd(),
  packageRoot,
  prompts,
  credentialStore,
  runtimeStarter = startForegroundRuntime,
  runtimeOptions = {},
  env = process.env,
  processRef = process,
  signal,
  tunnelResolver = findTunnelClient,
  configReader = readSetupConfig,
  configUpdater = updateSetupConfig,
  fileExists = isFile,
  directoryExists = isDirectory,
  withProgress = (_label, operation) => operation(),
  launcherInstaller = installLauncher,
  taskReader,
  taskStopper,
  taskInstaller,
  taskStarter,
  readinessProbe = probeReadyEndpoint,
  readinessTimeoutMs = 60_000,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const step = async operation => {
    signal?.throwIfAborted();
    try { return await operation(); }
    finally { signal?.throwIfAborted(); }
  };
  const originalPrompts = prompts;
  prompts = {
    ...originalPrompts,
    language: (...args) => step(() => originalPrompts.language(...args)),
    text: (...args) => step(() => originalPrompts.text(...args)),
    yesNo: (...args) => step(() => originalPrompts.yesNo(...args)),
    secret: (...args) => step(() => originalPrompts.secret(...args)),
  };
  let config;
  try { config = await configReader(configFile, { platform }); }
  catch (error) {
    return result(error?.code === "CONFIG_INVALID" || error?.code === "CONFIG_SECRET_FIELD_FORBIDDEN"
      ? "configInvalid" : "configUnavailable", initialLanguage, {}, error?.code);
  }

  const language = await prompts.language(config.language || initialLanguage);
  if (!["ja", "en"].includes(language)) return result("languageInvalid", initialLanguage);

  const workspaceDefault = typeof config.workspace === "string" && await directoryExists(config.workspace)
    ? config.workspace : path.resolve(cwd);
  let workspace;
  for (;;) {
    const input = await prompts.text(translate(language, "setup.prompt.workspace"), workspaceDefault);
    const candidate = path.resolve(input || workspaceDefault);
    if (await directoryExists(candidate)) { workspace = candidate; break; }
    prompts.write(`${translate(language, "setup.result.workspaceInvalid")}\n\n`);
  }

  const signedIn = await prompts.yesNo(translate(language, "setup.prompt.codexLogin"));
  if (!signedIn) return result("codexLoginRequired", language);

  const savedTunnelId = typeof config.tunnelId === "string" && TUNNEL_ID.test(config.tunnelId) ? config.tunnelId : "";
  const tunnelIdDisplay = savedTunnelId ? `${savedTunnelId.slice(0, 11)}...${savedTunnelId.slice(-4)}` : undefined;
  let tunnelId = await prompts.text(translate(language, "setup.prompt.tunnelId"), tunnelIdDisplay);
  tunnelId = tunnelId.trim() || savedTunnelId;
  if (!TUNNEL_ID.test(tunnelId)) {
    prompts.write(`${translate(language, "setup.hint.tunnelId", { url: TUNNEL_SETUP_URL })}\n`);
    tunnelId = (await prompts.text(translate(language, "setup.prompt.tunnelIdAfterVisit"))).trim();
    if (!TUNNEL_ID.test(tunnelId)) return result("tunnelIdRequired", language);
  }

  const hasSavedTunnel = typeof config.tunnelClientPath === "string" && await fileExists(config.tunnelClientPath);
  const foundTunnel = hasSavedTunnel ? config.tunnelClientPath : await tunnelResolver({ platform });
  let tunnelClientPath;
  for (;;) {
    const input = await prompts.text(translate(language, "setup.prompt.tunnelClient"), foundTunnel || "");
    const candidate = input ? path.resolve(input) : foundTunnel || "";
    if ((!input || pathsAdapter(platform).isAbsolute(input)) && candidate && await fileExists(candidate)) {
      tunnelClientPath = candidate;
      break;
    }
    prompts.write(`${translate(language, candidate ? "setup.result.tunnelClientInvalid" : "setup.result.tunnelClientRequired")}\n`);
    if (!candidate) prompts.write(`${translate(language, "setup.hint.tunnelClient", { url: TUNNEL_DOWNLOAD_URL })}\n`);
  }

  const taskDirectory = platform === "win32"
    ? path.resolve(config.taskDirectory || pathsAdapter(platform).taskDirectory({ env, home }))
    : pathsAdapter(platform).taskDirectory({ env, home });
  const setupPaths = pathsAdapter(platform);
  const runtimeDirectory = typeof setupPaths.runtimeDirectory === "function"
    ? setupPaths.runtimeDirectory({ env, home })
    : null;
  const tempDefault = typeof config.tempWorkspace === "string" && setupPaths.isAbsolute(config.tempWorkspace)
    ? config.tempWorkspace
    : setupPaths.tempDirectory({ env, home });

  async function chooseTempWorkspace() {
    prompts.write(`${translate(language, "setup.hint.tempWorkspace", { value: tempDefault })}\n`);
    for (;;) {
      const input = await prompts.text(translate(language, "setup.prompt.tempWorkspace"), tempDefault);
      const candidate = input ? path.resolve(input) : tempDefault;
      const prepared = await step(() => prepareTempWorkspace({
        value: candidate,
        platform,
        workspace,
        taskDirectory,
        runtimeDirectory,
        configFile,
        packageRoot,
      }));
      if (prepared.ok) return prepared;
      prompts.write(`${translate(language, "setup.result.tempWorkspaceInvalid", { code: prepared.code })}\n\n`);
    }
  }

  if (platform !== "win32") {
    const preparedTemp = await chooseTempWorkspace();
    const savedSettings = {
      language,
      workspace,
      tunnelId,
      tunnelClientPath,
      taskDirectory,
      tempWorkspace: preparedTemp.path,
      packageRoot: path.resolve(packageRoot),
      mode: "manual",
    };
    try { config = await step(() => configUpdater(configFile, savedSettings, { platform })); }
    catch (error) { return result("configUnavailable", language, {}, error?.code); }

    let credentialError = null;
    let hasCredential = false;
    try { hasCredential = await credentialStore.has(); }
    catch (error) { credentialError = error?.code || "CREDENTIAL_BACKEND_ERROR"; }
    if (!credentialError && !(hasCredential &&
        await prompts.yesNo(translate(language, "setup.prompt.reuseCredential")))) {
      const ensured = await ensureRuntimeKey({
        credentialStore,
        prompts,
        language,
        hasCredential,
        step,
      });
      if (!ensured.ok) credentialError = ensured.value || ensured.code;
    }

    const values = {
      startCommand: "thriftyrelay start",
      policyCommand: "thriftyrelay register-policy --file <policy.json>",
      tempWorkspace: preparedTemp.path,
      code: credentialError || "",
    };
    const code = credentialError ? "runtimeConfiguredCredentialWarning" : "runtimeConfigured";
    return {
      ok: true,
      saved: true,
      ready: false,
      code,
      language,
      message: translate(language, `setup.result.${code}`, values),
      ...(credentialError ? { credentialError } : {}),
      tempWorkspace: preparedTemp.path,
      config,
      configFile,
    };
  }

  const autoAtLogin = await prompts.yesNo(translate(language, "setup.prompt.autoStart"),
    translate(language, "setup.recommend.autoStart"));
  let mode = autoAtLogin ? "on-login-task" : "foreground";
  if (!autoAtLogin) {
    const manualTask = await prompts.yesNo(translate(language, "setup.prompt.manualTask"),
      translate(language, "setup.recommend.manualTask"));
    mode = manualTask ? "on-demand-task" : "foreground";
  }
  const preparedTemp = await chooseTempWorkspace();
  const savedSettings = {
    language,
    workspace,
    tunnelId,
    tunnelClientPath,
    taskDirectory,
    tempWorkspace: preparedTemp.path,
    packageRoot: path.resolve(packageRoot),
    mode,
  };
  const persistSettings = () => step(() => configUpdater(configFile, savedSettings, { platform }));
  const mergedSettings = { ...config, ...savedSettings };

  if (mode !== "foreground") {
    // Probe the platform before anything is written: selecting a task mode on a platform with
    // no installer must not leave a mode behind that start/stop can never satisfy.
    try { launcherAdapter(platform); }
    catch { return result("taskUnsupported", language); }

    let hasCredential;
    try { hasCredential = await credentialStore.has(); }
    catch (error) { return result("credentialBackendError", language, { code: error?.code || "CREDENTIAL_BACKEND_ERROR" }); }
    if (!(hasCredential && await prompts.yesNo(translate(language, "setup.prompt.reuseCredential")))) {
      const ensured = await ensureRuntimeKey({ credentialStore, prompts, language, step });
      if (!ensured.ok) {
        return result(ensured.code, language,
          ensured.code === "credentialWriteFailed" ? { code: ensured.value } : {});
      }
    }

    let launcherFile;
    try {
      launcherFile = await step(() => launcherInstaller({
        config: mergedSettings,
        platform,
        env,
        packageRoot: savedSettings.packageRoot,
      }));
    } catch (error) {
      return result(error?.code === "REMOTE_PLATFORM_UNSUPPORTED" ? "taskUnsupported" : "taskInstallFailed",
        language, { code: error?.code || "LAUNCHER_WRITE_FAILED" });
    }

    // Re-running setup must not start a second tunnel against a port the current task still
    // holds. Stop only a task this product registered; a missing task is the normal first run.
    const readExistingTask = taskReader || (options => taskAdapter(platform).readTask(options));
    let existingTask = null;
    try { existingTask = await readExistingTask({ name: TASK_NAME }); } catch { existingTask = null; }
    if (existingTask) {
      try {
        await step(() => withProgress(translate(language, "setup.progress.stoppingTask"), () =>
          (taskStopper || (options => stopTaskRuntime(options)))({
            config: mergedSettings,
            name: existingTask.name || TASK_NAME,
            platform,
            env,
          })));
      } catch (error) {
        return result("taskStopFailed", language, { code: error?.code || "TASK_STOP_FAILED" });
      }
    }

    let installed;
    try {
      installed = await step(() => withProgress(translate(language, "setup.progress.installingTask"), () =>
        (taskInstaller || (options => taskAdapter(platform).installTask(options)))({
          name: TASK_NAME,
          launcher: launcherFile,
          atLogon: mode === "on-login-task",
          user: env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : undefined,
        })));
    } catch (error) {
      return result(error?.code === "REMOTE_PLATFORM_UNSUPPORTED" ? "taskUnsupported" : "taskInstallFailed",
        language, { code: error?.code || "TASK_INSTALL_FAILED" });
    }
    if (!installed?.ok) return result("taskInstallFailed", language, { code: installed?.code || "TASK_INSTALL_FAILED" });

    try { config = await persistSettings(); }
    catch (error) { return result("configUnavailable", language, {}, error?.code); }

    const taskName = installed.name || TASK_NAME;
    let launchAttempted = false;
    let ready;
    try {
      await step(async () => {
        launchAttempted = true;
        await (taskStarter || (options => taskAdapter(platform).startTask(options)))({ name: taskName });
      });
      ready = await waitForReady({ probe: () => step(readinessProbe), timeoutMs: readinessTimeoutMs,
        sleep: milliseconds => step(() => sleep(milliseconds)) });
    } catch (error) {
      if (signal?.aborted && launchAttempted) {
        let stopped;
        try { stopped = await (taskStopper || stopTaskRuntime)({ config: mergedSettings, name: taskName, platform, env }); }
        catch { stopped = null; }
        if (!stopped?.ok) throw Object.assign(new Error("SETUP_CANCEL_STOP_UNCONFIRMED"), { code: "SETUP_CANCEL_STOP_UNCONFIRMED" });
        signal.throwIfAborted();
      }
      return result("taskStartFailed", language, { name: taskName, code: error?.code || "TASK_START_FAILED" });
    }
    return {
      ok: true,
      code: ready ? "taskInstalled" : "taskInstalledNotReady",
      language,
      message: translate(language,
        ready ? "setup.result.taskInstalled" : "setup.result.taskInstalledNotReady",
        { name: taskName, tempWorkspace: preparedTemp.path }),
      saved: true,
      tempWorkspace: preparedTemp.path,
      config,
      configFile,
      task: {
        name: taskName,
        launcher: launcherFile,
        atLogon: mode === "on-login-task",
        state: installed.state,
        ready,
      },
    };
  }

  let hasCredential;
  try { hasCredential = await credentialStore.has(); }
  catch (error) { return result("credentialBackendError", language, { code: error?.code || "CREDENTIAL_BACKEND_ERROR" }); }
  if (!(hasCredential && await prompts.yesNo(translate(language, "setup.prompt.reuseCredential")))) {
      const ensured = await ensureRuntimeKey({ credentialStore, prompts, language, step });
    if (!ensured.ok) {
      return result(ensured.code, language,
        ensured.code === "credentialWriteFailed" ? { code: ensured.value } : {});
    }
  }

  try {
    config = await persistSettings();
  } catch (error) {
    return result("configUnavailable", language, {}, error?.code);
  }
  signal?.throwIfAborted();
  const runtime = await withProgress(translate(language, "setup.progress.starting"), () => runtimeStarter({
    ...runtimeOptions,
    config,
    configFile,
    env,
    platform,
    credentialStore,
    packageRoot: savedSettings.packageRoot,
    processRef,
  }));
  return {
    ok: true,
    code: "runtimeReady",
    language,
    message: translate(language, "setup.result.runtimeReady", { tempWorkspace: preparedTemp.path }),
    saved: true,
    tempWorkspace: preparedTemp.path,
    config,
    configFile,
    runtime,
  };
}

export function createConsolePrompts({ input = process.stdin, output = process.stdout, signal, onCancel } = {}) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    throw Object.assign(new Error("SETUP_INTERACTIVE_REQUIRED"), { code: "SETUP_INTERACTIVE_REQUIRED" });
  }
  const readline = createInterface({ input, output, terminal: true });
  let closed = false;
  let cancelRequested = false;
  let selectedLanguage = "en";
  const requestCancel = () => { cancelRequested = true; onCancel?.(); };
  readline.on("SIGINT", requestCancel);
  const close = () => {
    if (!closed) {
      closed = true;
      readline.off("SIGINT", requestCancel);
      readline.close();
    }
  };
  const cancelled = () => Object.assign(new Error("SETUP_CANCELLED"), { code: "SETUP_CANCELLED" });
  const ask = async question => {
    if (closed || cancelRequested || signal?.aborted) throw cancelled();
    const abort = new AbortController();
    const cancel = () => { requestCancel(); abort.abort(); };
    readline.once("SIGINT", cancel);
    readline.once("close", cancel);
    signal?.addEventListener("abort", cancel, { once: true });
    try { return await readline.question(question, { signal: abort.signal }); }
    catch (error) { if (abort.signal.aborted) throw cancelled(); throw error; }
    finally {
      readline.off("SIGINT", cancel);
      readline.off("close", cancel);
      signal?.removeEventListener("abort", cancel);
    }
  };
  return {
    async language(defaultLanguage) {
      const value = (await ask(`${translate(defaultLanguage, "setup.prompt.language")}\n\n> `)).trim().toLowerCase();
      selectedLanguage = value || defaultLanguage;
      return selectedLanguage;
    },
    async text(prompt, defaultValue) {
      const defaultLine = defaultValue === undefined ? "" : `\n${translate(selectedLanguage, "setup.prompt.default", { value: defaultValue || "—" })}`;
      return (await ask(`${prompt}${defaultLine}\n\n> `)).trim();
    },
    async yesNo(prompt, recommendation) {
      const recommendedLine = recommendation ? `\n${translate(selectedLanguage, "setup.prompt.recommended", { value: recommendation })}` : "";
      while (true) {
        const value = (await ask(`${prompt}${recommendedLine}\n\n[y/n]> `)).trim().toLowerCase();
        if (["y", "yes"].includes(value)) return true;
        if (["n", "no"].includes(value)) return false;
        output.write(`${translate(selectedLanguage, "setup.prompt.answerAgain")}\n`);
      }
    },
    async secret(prompt) {
      close();
      output.write(`${prompt}\n\n> `);
      input.setRawMode(true);
      input.resume();
      return new Promise((resolve, reject) => {
        let value = "";
        let finished = false;
        const finish = (error) => {
          if (finished) return;
          finished = true;
          input.off("data", onData);
          signal?.removeEventListener("abort", abortSecret);
          input.off("end", abortSecret);
          try { input.setRawMode(false); } catch {}
          output.write("\n");
          if (error) reject(error);
          else resolve(value);
        };
        const abortSecret = () => finish(cancelled());
        const onData = chunk => {
          const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          for (const character of text) {
            if (character === "\u0003") {
              requestCancel();
              finish(cancelled());
              return;
            }
            if (character === "\r" || character === "\n") {
              finish();
              return;
            }
            if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
            else if (character >= " " && character !== "\u007f") value += character;
          }
        };
        input.on("data", onData);
        input.once("end", abortSecret);
        signal?.addEventListener("abort", abortSecret, { once: true });
        if (signal?.aborted) abortSecret();
      });
    },
    write(value) { output.write(value); },
    close,
  };
}
