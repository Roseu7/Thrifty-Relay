#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigPath, formatLanguageError, parseLanguageFlags, resolveLanguagePreference, translate } from "../src/i18n/index.mjs";
import { collectDoctorChecks, doctorMessageKey, publicDoctorChecks } from "../src/cli/doctor.mjs";
import { withSpinner } from "../src/cli/spinner.mjs";
import { runSettingsCommand } from "../src/cli/settings.mjs";
import { createConsolePrompts, runSetup } from "../src/cli/setup.mjs";
import { runUninstallCommand } from "../src/cli/uninstall.mjs";
import { readSetupConfig } from "../src/config.mjs";
import { createCredentialStore, taskAdapter, TASK_NAME } from "../src/platform/index.mjs";
import { startForegroundRuntime } from "../src/runtime/foreground.mjs";
import { startForegroundRuntimeWithRecord } from "../src/runtime/foreground-record.mjs";
import { startBackgroundRuntime, stopBackgroundRuntime } from "../src/runtime/background.mjs";
import { runtimeStateFile } from "../src/runtime/state.mjs";
import { waitForReady } from "../src/runtime/readiness.mjs";
import { stopTaskRuntime } from "../src/runtime/task-control.mjs";

const COMMANDS = ["setup", "start", "stop", "restart", "status", "doctor", "settings", "uninstall"];
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// These scripts parse their own arguments, prompt on the terminal, and in one case re-run
// themselves elevated, so they run as child processes instead of being reimplemented here.
const SCRIPT_COMMANDS = Object.freeze({
  mcp: "mcp-control.mjs",
  recover: "recover-guided.mjs",
  "register-policy": "register-policy.mjs",
  lang: "lang.mjs",
});

function runScript(file, args) {
  // Ctrl+C reaches the child through the shared terminal. Exiting here at once would return
  // the prompt while the child is still cancelling, so wait for it and report its result.
  const waitForChild = () => {};
  process.on("SIGINT", waitForChild);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  }).finally(() => process.off("SIGINT", waitForChild));
}

function helpText(language) {
  return [
    translate(language, "cli.help.heading"),
    translate(language, "cli.help.commands"),
    translate(language, "cli.help.options"),
    translate(language, "cli.help.settings"),
    translate(language, "cli.help.phase2"),
  ].join("\n\n") + "\n";
}

function unknownChecks() {
  return ["environment", "config", "credentials", "startup", "readiness", "policy"].map(id => ({
    id,
    status: "UNKNOWN",
    code: "DOCTOR_INTERNAL_ERROR",
  }));
}

function exitCode(checks) {
  if (checks.some(item => item.status === "FAIL")) return 1;
  if (checks.some(item => item.status === "UNKNOWN")) return 2;
  return 0;
}

function humanReport(command, checks, language) {
  if (command === "status") {
    const readiness = checks.find(item => item.id === "readiness") || { code: "DOCTOR_INTERNAL_ERROR" };
    const state = readiness.code === "RUNTIME_RUNNING" ? "running"
      : readiness.evidence?.state === "stopped" ? "stopped"
        : ["starting", "stopping", "failed"].includes(readiness.evidence?.state) ? readiness.evidence.state : "unknown";
    const lines = [translate(language, `status.${state}`)];
    if (state === "unknown" || state === "failed" || exitCode(checks) !== 0) {
      lines.push(translate(language, "status.details", { code: readiness.code }));
    }
    return `${lines.join("\n")}\n`;
  }
  const lines = [translate(language, "doctor.heading")];
  for (const item of checks) {
    lines.push(translate(language, "doctor.line", {
      name: translate(language, `doctor.check.${item.id}`),
      status: translate(language, `doctor.status.${item.status.toLowerCase()}`),
      code: item.code,
      message: translate(language, item.messageKey || doctorMessageKey(item.code), {
        policyCommand: "thriftyrelay register-policy --file <policy.json>",
      }),
    }));
  }
  lines.push("");
  for (const status of ["PASS", "WARN", "FAIL", "UNKNOWN"]) {
    const count = checks.filter(item => item.status === status).length;
    if (count) lines.push(translate(language, "doctor.summary", {
      status: translate(language, `doctor.status.${status.toLowerCase()}`), count,
    }));
  }
  return `${lines.join("\n")}\n`;
}

const RUNTIME_EXIT_CODES = Object.freeze({
  RUNTIME_ALREADY_RUNNING: 2,
  RUNTIME_START_IN_PROGRESS: 2,
  RUNTIME_BUSY: 2,
  RUNTIME_OWNER_UNKNOWN: 2,
  RUNTIME_OWNER_MISMATCH: 2,
  RUNTIME_OWNER_UNVERIFIED: 2,
  RUNTIME_STATE_STALE: 2,
  RUNTIME_STATE_CONFLICT: 2,
  RUNTIME_START_FAILED: 2,
  RUNTIME_READINESS_TIMEOUT: 2,
  RUNTIME_TUNNEL_START_FAILED: 2,
  RUNTIME_TUNNEL_EXITED: 2,
  RUNTIME_STOP_UNCONFIRMED: 2,
  RUNTIME_AS_ROOT: 1,
  RUNTIME_STATE_INSECURE: 1,
  RUNTIME_STATE_UNAVAILABLE: 1,
  RUNTIME_STATE_INVALID: 1,
  RUNTIME_LOG_UNAVAILABLE: 1,
  RUNTIME_DEPENDENCY_MISSING: 1,
  LOCAL_ENDPOINT_IN_USE: 2,
});

function runtimeFailure(error, language, stderr) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : "RUNTIME_START_FAILED";
  const message = translate(language, `runtime.error.${code}`);
  stderr.write(`${code}: ${message === `runtime.error.${code}` ? translate(language, "runtime.error.generic") : message}\n`);
  return RUNTIME_EXIT_CODES[code] ?? 1;
}

async function waitOnRuntime(runtime, { stdout, stderr, language, processRef }) {
  stdout.write(`${translate(language, "runtime.started")}\n`);
  stdout.write(`${translate(language, "runtime.closing")}\n`);
  const result = await runtime.waitForExit({ processRef });
  // The shell convention for an interrupted foreground process is 130 / 143 / 129.
  // Those are not runtime failures and must not be rewritten to 1.
  if ([129, 130, 143].includes(result.exitCode)) return result.exitCode;
  if (result.exitCode !== 0) return runtimeFailure({ code: result.code }, language, stderr);
  if (result.code === "RUNTIME_STOPPED") stdout.write(`${translate(language, "runtime.error.RUNTIME_STOPPED")}\n`);
  return result.exitCode;
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  collectChecks = collectDoctorChecks,
  checkOptions = {},
  setupRunner = runSetup,
  uninstallRunner = runUninstallCommand,
  promptFactory = createConsolePrompts,
  credentialStore: injectedCredentialStore,
  runtimeStarter = startForegroundRuntime,
  foregroundStarter = startForegroundRuntimeWithRecord,
  backgroundStarter = startBackgroundRuntime,
  backgroundStopper = stopBackgroundRuntime,
  runtimeOptions = {},
  processRef = process,
  scriptRunner = runScript,
} = {}) {
  const configFile = getConfigPath({ env, platform, home });
  let parsed;
  try { parsed = parseLanguageFlags(argv); }
  catch (error) {
    const preference = await resolveLanguagePreference({ configFile }).catch(() => ({ language: "en" }));
    stderr.write(`${formatLanguageError(error, preference.language)}\n`);
    stderr.write(helpText(preference.language));
    return 2;
  }
  const preference = await resolveLanguagePreference({ explicitLanguage: parsed.explicitLanguage, configFile })
    .catch(() => ({ language: "en" }));
  const language = preference.language;
  const [command, ...args] = parsed.args;

  if (!command || command === "help" || command === "-h" || command === "--help") {
    if (args.length) {
      stderr.write(`${translate(language, "cli.arguments.invalid")}\n`);
      stderr.write(helpText(language));
      return 2;
    }
    stdout.write(helpText(language));
    return 0;
  }
  if (Object.hasOwn(SCRIPT_COMMANDS, command)) {
    // lang.mjs reads --lang as the value to save, so forwarding the display option would
    // change the saved language; the value to save is given as `lang ja` instead.
    const languageArgs = parsed.explicitLanguage && command !== "lang" ? ["--lang", parsed.explicitLanguage] : [];
    return scriptRunner(path.join(PACKAGE_ROOT, "scripts", SCRIPT_COMMANDS[command]), [...args, ...languageArgs]);
  }
  if (!COMMANDS.includes(command)) {
    stderr.write(`${translate(language, "cli.command.unknown")}\n`);
    stderr.write(helpText(language));
    return 2;
  }

  const jsonFlags = args.filter(argument => argument === "--json").length;
  const foregroundFlags = args.filter(argument => argument === "--foreground").length;
  const yesFlags = args.filter(argument => argument === "--yes").length;
  const dryRunFlags = args.filter(argument => argument === "--dry-run").length;
  const remaining = args.filter(argument =>
    !["--json", "--foreground", "--yes", "--dry-run"].includes(argument));
  const foreground = foregroundFlags === 1;
  const json = jsonFlags === 1;
  const yes = yesFlags === 1;
  const dryRun = dryRunFlags === 1;
  const jsonAllowed = json && (
    (["doctor", "status"].includes(command) && remaining.length === 0) ||
    (command === "settings" && remaining.length === 1 && remaining[0] === "show")
  );
  if (jsonFlags > 1 || foregroundFlags > 1 || yesFlags > 1 || dryRunFlags > 1 ||
      (foreground && !(platform !== "win32" && ["start", "restart"].includes(command))) ||
      ((yes || dryRun) && command !== "uninstall") ||
      (json && !jsonAllowed) || (command !== "settings" && remaining.length)) {
    stderr.write(`${translate(language, "cli.arguments.invalid")}\n`);
    stderr.write(helpText(language));
    return 2;
  }

  if (command === "settings") {
    return runSettingsCommand({
      args: remaining,
      json,
      language,
      explicitLanguage: parsed.explicitLanguage,
      configFile,
      platform,
      env,
      stdout,
      stderr,
      stdin,
    });
  }

  const credentialStore = injectedCredentialStore || createCredentialStore({ platform, env });

  if (command === "uninstall") {
    return uninstallRunner({
      platform,
      env,
      home,
      configFile,
      language,
      yes,
      dryRun,
      stdout,
      stderr,
      stdin,
      credentialStore,
    });
  }

  if (command === "setup") {
    if (!stdin?.isTTY || !stdout?.isTTY) {
      stderr.write(`${translate(language, "setup.result.interactiveRequired")}\n`);
      return 2;
    }
    let prompts;
    let configured;
    const setupAbort = new AbortController();
    const interruptSetup = () => {
      if (setupAbort.signal.aborted) return;
      setupAbort.abort(Object.assign(new Error("SETUP_CANCELLED"), { code: "SETUP_CANCELLED" }));
      stderr.write(`\n${translate(language, "setup.cancelling")}\n`);
    };
    processRef.on?.("SIGINT", interruptSetup);
    try { prompts = promptFactory({ input: stdin, output: stdout, signal: setupAbort.signal, onCancel: interruptSetup }); }
    catch {
      processRef.off?.("SIGINT", interruptSetup);
      stderr.write(`${translate(language, "setup.result.interactiveRequired")}\n`);
      return 2;
    }
    try {
      stdout.write(`${translate(language, "setup.cancelHint")}\n\n`);
      configured = await setupRunner({
        configFile,
        initialLanguage: language,
        platform,
        home,
        cwd,
        packageRoot: PACKAGE_ROOT,
        prompts,
        credentialStore,
        runtimeStarter,
        runtimeOptions,
        env,
        processRef,
        signal: setupAbort.signal,
        withProgress: (label, operation) => withSpinner(label, operation, { stream: stderr, env }),
      });
      setupAbort.signal.throwIfAborted();
      if (!configured.ok) {
        stderr.write(`${configured.code}: ${configured.message}\n`);
        return configured.code === "SETUP_CONFIG_UNAVAILABLE" || configured.code === "SETUP_CONFIG_INVALID" ? 1 : 2;
      }
      if (configured.saved === true && configured.ready === false) {
        stdout.write(`${configured.message}\n`);
        return 0;
      }
      if (configured.task) {
        stdout.write(`${configured.message}\n`);
        return configured.task.ready ? 0 : 2;
      }
      if (!configured.runtime || typeof configured.runtime.waitForExit !== "function") {
        return runtimeFailure({ code: "RUNTIME_NOT_STARTED" }, configured.language, stderr);
      }
      const runtimeExit = await waitOnRuntime(configured.runtime, { stdout, stderr, language: configured.language, processRef });
      if (setupAbort.signal.aborted) stderr.write(`${translate(language, "setup.result.cancelled")}\n`);
      return runtimeExit;
    } catch (error) {
      if (/^(?:RUNTIME_CLEANUP_|SETUP_CANCEL_STOP_UNCONFIRMED)/.test(error?.code || "")) {
        return runtimeFailure(error, language, stderr);
      }
      if (error?.code === "SETUP_CANCELLED" || setupAbort.signal.aborted) {
        if (configured?.runtime) {
          const stopped = await configured.runtime.waitForExit();
          if (stopped.exitCode === 1) return runtimeFailure({ code: stopped.code }, language, stderr);
        }
        stderr.write(`${translate(language, "setup.result.cancelled")}\n`);
        return 130;
      }
      if (error?.code === "RUNTIME_START_CANCELLED") {
        stderr.write(`${translate(language, "runtime.error.RUNTIME_START_CANCELLED")}\n`);
        return Number.isSafeInteger(error.exitCode) ? error.exitCode : 130;
      }
      return runtimeFailure(error, language, stderr);
    } finally {
      processRef.off?.("SIGINT", interruptSetup);
      prompts?.close?.();
    }
  }

  if (["start", "restart"].includes(command)) {
    let config;
    try { config = await readSetupConfig(configFile, { platform }); }
    catch (error) { return runtimeFailure(error, language, stderr); }
    if (platform !== "win32") {
      const stateFile = runtimeStateFile({ platform, env, home });
      try {
        if (command === "restart") await backgroundStopper({ stateFile, platform });
        if (foreground || config.mode === "foreground") {
          const runtime = await withSpinner(translate(language, `cli.progress.${command}`), () => foregroundStarter({
            ...runtimeOptions,
            config,
            configFile,
            env,
            home,
            platform,
            stateFile,
            credentialStore,
            packageRoot: PACKAGE_ROOT,
            processRef,
            runtimeStarter,
          }), { stream: stderr, env });
          return await waitOnRuntime(runtime, { stdout, stderr, language, processRef });
        }
        await withSpinner(translate(language, `cli.progress.${command}`), () => backgroundStarter({
          ...runtimeOptions,
          config,
          configFile,
          env,
          platform,
          home,
          packageRoot: PACKAGE_ROOT,
          stateFile,
        }), { stream: stderr, env });
        stdout.write(`${translate(language, "runtime.backgroundStarted")}\n`);
        return 0;
      } catch (error) {
        return runtimeFailure(error, language, stderr);
      }
    }
    if (config.mode && config.mode !== "foreground") {
      if (!["on-login-task", "on-demand-task"].includes(config.mode)) {
        return runtimeFailure({ code: "CONFIG_INCOMPLETE" }, language, stderr);
      }
      const taskName = config.taskName || TASK_NAME;
      try {
        if (command === "restart") await stopTaskRuntime({ config, name: taskName, platform, env });
        await withSpinner(translate(language, "cli.progress.startingTask"),
          () => taskAdapter(platform).startTask({ name: taskName }), { stream: stderr, env });
        const ready = await withSpinner(translate(language, "cli.progress.checking"),
          () => waitForReady({ timeoutMs: checkOptions.readinessTimeoutMs || 60_000 }), { stream: stderr, env });
        if (!ready) {
          stderr.write(`${translate(language, "runtime.error.LOCAL_READINESS_UNKNOWN")}\n`);
          return 2;
        }
      } catch (error) {
        return runtimeFailure(
          { code: error?.code === "REMOTE_PLATFORM_UNSUPPORTED" ? "TASK_MODE_NOT_AVAILABLE" : "TASK_START_FAILED" },
          language, stderr);
      }
      stdout.write(`${translate(language, "runtime.taskStarted")}\n`);
      return 0;
    }
    if (!config.mode && (!config.workspace || !config.tunnelId || !config.tunnelClientPath)) {
      return runtimeFailure({ code: "CONFIG_INCOMPLETE" }, language, stderr);
    }
    try {
      const runtime = await withSpinner(translate(language, `cli.progress.${command}`), () => runtimeStarter({
        ...runtimeOptions,
        config,
        configFile,
        env,
        platform,
        credentialStore,
        packageRoot: PACKAGE_ROOT,
        processRef,
      }), { stream: stderr, env });
      return await waitOnRuntime(runtime, { stdout, stderr, language, processRef });
    } catch (error) {
      if (error?.code === "LOCAL_ENDPOINT_IN_USE") {
        stderr.write(`${error.code}: ${translate(language, "runtime.error.LOCAL_ENDPOINT_IN_USE")}\n`);
        return 2;
      }
      if (error?.code === "RUNTIME_START_CANCELLED" && Number.isSafeInteger(error.exitCode)) {
        return error.exitCode;
      }
      return runtimeFailure(error, language, stderr);
    }
  }

  if (command === "stop") {
    if (platform !== "win32") {
      const stateFile = runtimeStateFile({ platform, env, home });
      try {
        const stopped = await withSpinner(translate(language, "cli.progress.stopping"),
          () => backgroundStopper({ stateFile, platform, env, home }),
          { stream: stderr, env });
        stdout.write(`${translate(language, stopped?.stopped ? "runtime.backgroundStopped" : "runtime.alreadyStopped")}\n`);
        return 0;
      } catch (error) {
        return runtimeFailure(error, language, stderr);
      }
    }
    let config;
    try { config = await readSetupConfig(configFile, { platform }); }
    catch (error) { return runtimeFailure(error, language, stderr); }
    if (config.mode && config.mode !== "foreground") {
      if (!["on-login-task", "on-demand-task"].includes(config.mode)) {
        return runtimeFailure({ code: "CONFIG_INCOMPLETE" }, language, stderr);
      }
      try {
        const stopped = await withSpinner(translate(language, "cli.progress.stoppingTask"),
          () => stopTaskRuntime({ config, name: config.taskName || TASK_NAME, platform, env }),
          { stream: stderr, env });
        if (!stopped.ok) return runtimeFailure({ code: stopped.code || "TASK_STOP_FAILED" }, language, stderr);
      } catch (error) {
        return runtimeFailure({ code: error?.code || "TASK_STOP_FAILED" }, language, stderr);
      }
      stdout.write(`${translate(language, "runtime.taskStopped")}\n`);
      return 0;
    }
    if (config.mode !== "foreground") {
      return runtimeFailure({ code: config.mode ? "TASK_MODE_NOT_AVAILABLE" : "CONFIG_INCOMPLETE" }, language, stderr);
    }
    const { probeLoopback } = await import("../src/cli/doctor.mjs");
    const probe = await withSpinner(translate(language, "cli.progress.checking"),
      () => probeLoopback().catch(() => ({ state: "unknown" })), { stream: stderr, env });
    if (probe.state === "stopped") {
      stdout.write(`${translate(language, "runtime.alreadyStopped")}\n`);
      return 0;
    }
    stderr.write(`${translate(language, probe.state === "responding" ? "runtime.stopOwner" : "runtime.error.LOCAL_READINESS_UNKNOWN")}\n`);
    return 2;
  }

  let checks;
  try {
    checks = await withSpinner(translate(language, "cli.progress.checking"),
      () => collectChecks({ ...checkOptions, env, platform, home, credentialStore: checkOptions.credentialStore || credentialStore }),
      { stream: stderr, env, json });
    if (!Array.isArray(checks) || checks.length !== 6) checks = unknownChecks();
  } catch {
    checks = unknownChecks();
  }

  if (json) stdout.write(`${JSON.stringify(publicDoctorChecks(checks), null, 2)}\n`);
  else stdout.write(humanReport(command, checks, language));
  return exitCode(checks);
}

// npm runs this file through a link in its global directory. Node resolves the module URL to
// the link target while argv keeps the link, so only the real paths can be compared.
function invokedAsEntry() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (invokedAsEntry()) {
  process.exitCode = await runCli();
}
