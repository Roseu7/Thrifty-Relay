import { spawn } from "node:child_process";

// Linux and macOS reach their secret store through a command line tool, so they share
// the rules for running one. The rules are not cosmetic:
// - the caller's environment is filtered, because it may hold the runtime key itself;
// - a hung helper would otherwise hang setup, so a deadline kills it;
// - oversized output is an error rather than a truncated secret.

const TIMEOUT_MS = 15000;
const MAX_OUTPUT = 65536;

const ENVIRONMENT_ALLOWLIST = /^(path|home|user|logname|shell|tmpdir|lang|lc_all|xdg_runtime_dir|dbus_session_bus_address)$/i;

function backendError() {
  return Object.assign(new Error("CREDENTIAL_BACKEND_ERROR"), { code: "CREDENTIAL_BACKEND_ERROR" });
}

// Resolves with the exit status and both streams so the caller can tell "no such item"
// from "the backend is broken". A missing binary rejects with ENOENT, which the callers
// translate into CREDENTIAL_BACKEND_UNAVAILABLE.
export function runSecretCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ENVIRONMENT_ALLOWLIST.test(key))),
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (stdout.length + chunk.length > MAX_OUTPUT) overflow = true;
      else stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      if (stderr.length < 4096) stderr += chunk;
    });

    const timeout = setTimeout(() => child.kill(), TIMEOUT_MS);
    timeout.unref?.();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };

    // The error event carries the ENOENT a caller needs to recognise, so it is forwarded
    // unchanged; anything else means the helper itself failed.
    child.once("error", error => finish(error));
    child.once("close", code => {
      if (overflow) finish(backendError());
      else finish(null, { code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => child.kill());
    child.stdin.end(input === undefined ? "" : input, "utf8");
  });
}
