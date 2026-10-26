import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { formatLanguageError, parseLanguageFlags, resolveLanguagePreference, translate } from "../src/i18n/index.mjs";
import { installPolicy, parsePolicy, policyFile, readPolicy } from "../src/platform/index.mjs";
import { psLiteral } from "../src/platform/win32/powershell.mjs";

// The registration is the one permission change a card cannot make (design 2.6.3). It is a
// local, attended command: it prints the whole policy that is about to be written, and only
// then asks the operating system to elevate. The elevated child receives a hash of exactly
// what was printed, so a temporary file swapped between the prompt and the write is refused.

function registrationError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

export function parseArguments(argv) {
  const options = { yes: false };
  const rest = argv.slice();
  while (rest.length > 0) {
    const argument = rest.shift();
    if (argument === "--show") options.show = true;
    else if (argument === "--revoke") options.revoke = true;
    else if (argument === "--yes") options.yes = true;
    else if (argument === "--file") options.file = rest.shift();
    else if (argument === "--apply") options.apply = rest.shift();
    else if (argument === "--sha256") options.sha256 = rest.shift();
    else if (argument === "--expect") options.expect = rest.shift();
    else if (argument === "--kill-switch") options.killSwitch = rest.shift();
    else throw registrationError("REGISTER_ARGUMENT_UNKNOWN", argument);
  }
  return options;
}

export function commandOf(options) {
  const exclusive = (...names) => names.every(name => !options[name]);
  // The expected generation is part of the elevated contract, not a user option.
  if (options.expect !== undefined && options.apply === undefined) throw registrationError("REGISTER_ARGUMENTS_INVALID");
  if (options.apply !== undefined) {
    if (!exclusive("show", "revoke", "file", "killSwitch")) throw registrationError("REGISTER_ARGUMENTS_INVALID");
    return "apply";
  }
  if (options.show) {
    if (!exclusive("revoke", "file", "killSwitch")) throw registrationError("REGISTER_ARGUMENTS_INVALID");
    return "show";
  }
  if (options.file !== undefined) {
    if (options.revoke) throw registrationError("REGISTER_ARGUMENTS_INVALID");
    return "write";
  }
  if (options.revoke || options.killSwitch !== undefined) return "write";
  throw registrationError("REGISTER_ARGUMENTS_INVALID");
}

function parseSwitch(value) {
  if (value === "on") return true;
  if (value === "off") return false;
  throw registrationError("REGISTER_ARGUMENTS_INVALID", value);
}

// Every write moves the generation forward, because that counter is what revokes approvals
// issued under the previous rules (design 2.6.2). A draft cannot choose it, or a stale file
// could roll the registration back.
export function nextRegistration({ current = null, draft = null, killSwitch, platform = process.platform } = {}) {
  if (draft === null && current === null) throw registrationError("POLICY_MISSING", policyFile({ platform }));
  const base = draft === null ? current : parsePolicy(draft, platform);
  const next = {
    generation: (current?.generation ?? 0) + 1,
    kill_switch: killSwitch ?? base.kill_switch,
    full_access: base.full_access,
    tunnel_ids: base.tunnel_ids,
    workspace_roots: base.workspace_roots,
    scratch_roots: base.scratch_roots,
    protected_paths: base.protected_paths,
  };
  const text = JSON.stringify(next, null, 2) + "\n";
  // Reading back what is about to be written is what makes the preview the installation.
  return { text, policy: parsePolicy(text, platform) };
}

function runElevated(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: false });
    child.once("error", () => reject(registrationError("POLICY_INSTALL_ELEVATION_FAILED", command)));
    child.once("exit", code => (code === 0
      ? resolve()
      : reject(registrationError("POLICY_INSTALL_ELEVATION_FAILED", String(code)))));
  });
}

function elevate(args) {
  if (process.platform === "win32") {
    // Only paths with spaces need quoting inside the list; Start-Process joins the elements
    // with spaces and does not add quotes of its own.
    const list = args.map(value => psLiteral(/\s/.test(value) ? '"' + value + '"' : value)).join(",");
    const script = "$p = Start-Process -FilePath " + psLiteral(process.execPath) +
      " -ArgumentList " + list + " -Verb RunAs -Wait -PassThru; exit $p.ExitCode";
    return runElevated("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }
  return runElevated("sudo", [process.execPath, ...args]);
}

async function showPolicy(file, language) {
  try {
    console.log(JSON.stringify(await readPolicy(file), null, 2));
  } catch (error) {
    if (error.code !== "POLICY_MISSING") throw error;
    console.log(translate(language, "register.missing", { file }));
  }
}

async function applyPolicy(options, language) {
  if (typeof options.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(options.sha256)) {
    throw registrationError("REGISTER_ARGUMENTS_INVALID");
  }
  const text = await fs.readFile(options.apply, "utf8");
  if (createHash("sha256").update(text).digest("hex") !== options.sha256) {
    throw registrationError("REGISTER_CONTENT_CHANGED", options.apply);
  }
  const expected = Number(options.expect);
  if (!Number.isInteger(expected) || expected < 0) throw registrationError("REGISTER_ARGUMENTS_INVALID");
  // The elevated child validates the document itself instead of trusting the caller that
  // started it, and writes only the canonical policy location.
  const file = policyFile();
  parsePolicy(text);
  // A revocation that happened while the preview was on screen must not be undone by a stale
  // generation, so the current registration is read here rather than assumed.
  const current = await fs.readFile(file, "utf8").then(parsePolicy, error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if ((current?.generation ?? 0) !== expected) {
    throw registrationError("REGISTER_GENERATION_CHANGED", String(current?.generation ?? 0));
  }
  await installPolicy({ file, content: text });
}

async function main() {
  const parsed = parseLanguageFlags(process.argv.slice(2));
  const language = (await resolveLanguagePreference({ explicitLanguage: parsed.explicitLanguage })).language;
  const options = parseArguments(parsed.args);
  const command = commandOf(options);
  if (command === "apply") return await applyPolicy(options, language);

  const file = policyFile();
  if (command === "show") return await showPolicy(file, language);

  let current = null;
  try {
    current = await readPolicy(file);
  } catch (error) {
    // A host that was never registered is a normal starting point. An unreadable or
    // unprotected policy is not: overwriting it would hide a failure the operator has to see.
    if (error.code !== "POLICY_MISSING") throw error;
  }
  if (options.revoke && current === null) throw registrationError("POLICY_MISSING", file);
  const draft = options.file === undefined ? null : await fs.readFile(options.file, "utf8");
  const killSwitch = options.killSwitch === undefined ? undefined : parseSwitch(options.killSwitch);
  const { text } = nextRegistration({ current, draft, killSwitch });

  console.log(translate(language, "register.preview", { file }));
  console.log(text);
  if (!options.yes) {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question(translate(language, "register.confirm"));
      if (answer.trim().toLowerCase() !== "yes") {
        console.log(translate(language, "register.cancelled"));
        return;
      }
    } finally {
      terminal.close();
    }
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-policy-"));
  try {
    const temporary = path.join(workspace, "policy.json");
    await fs.writeFile(temporary, text, { mode: 0o600 });
    console.log(translate(language, "register.elevating"));
    await elevate([
      path.resolve(import.meta.filename), "--apply", temporary,
      "--sha256", createHash("sha256").update(text).digest("hex"),
      "--expect", String(current?.generation ?? 0),
    ]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
  // Verification runs as the unprivileged caller: if this process could still write the
  // policy, the registration did not achieve anything and readPolicy says so.
  await readPolicy(file);
  console.log(translate(language, "register.success", { file }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main().catch(async error => {
    const { language } = await resolveLanguagePreference().catch(() => ({ language: "en" }));
    if (error.code === "LANG_UNSUPPORTED" || error.code === "LANG_ARGUMENTS_INVALID") {
      console.error(formatLanguageError(error, language));
      process.exitCode = 2;
      return;
    }
    if (error.code === "REGISTER_ARGUMENTS_INVALID" || error.code === "REGISTER_ARGUMENT_UNKNOWN") {
      console.error(translate(language, "register.usage"));
      process.exitCode = 2;
      return;
    }
    console.error(translate(language, "register.failure", {
      code: error.code ?? "REGISTER_FAILED",
      detail: error.detail === undefined ? "" : "(" + error.detail + ")",
    }));
    process.exitCode = 1;
  });
}
