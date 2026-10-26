import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { inspectRecovery, recoverExecution } from "../src/mcp/recovery.mjs";
import { formatLanguageError, parseLanguageFlags, resolveLanguagePreference, translate } from "../src/i18n/index.mjs";

let language = "en";
try {
  const parsed = parseLanguageFlags(process.argv.slice(2));
  language = (await resolveLanguagePreference({ explicitLanguage: parsed.explicitLanguage })).language;
  const [action, ...args] = parsed.args;
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--task-dir", "--approval"].includes(args[i]) || !args[i + 1] || flags[args[i]]) throw new Error("Arguments");
    flags[args[i]] = args[i + 1];
  }
  if (!["inspect", "recover"].includes(action) || !path.isAbsolute(flags["--task-dir"] || "")) throw new Error("Arguments");
  const dir = await fs.realpath(flags["--task-dir"]);
  if (dir === path.parse(dir).root || dir.toLowerCase() === os.homedir().toLowerCase()) throw new Error("Arguments");
  let result;
  if (action === "inspect") {
    if (flags["--approval"]) throw new Error("Arguments");
    result = await inspectRecovery(dir);
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw Object.assign(new Error(), { code: "REMOTE_LOCAL_INTERACTIVE_CONSOLE_REQUIRED" });
    const approval = JSON.parse((await fs.readFile(flags["--approval"], "utf8")).replace(/^\uFEFF/, ""));
    result = await recoverExecution({ dir, approval, confirm: async ({ task_id, lock_sha256 }) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const phrase = `UNLOCK ${task_id} ${lock_sha256.slice(0, 12)}`;
        return await rl.question(translate(language, "remoteMaintenance.prompt", { phrase })) === phrase;
      } finally { rl.close(); }
    } });
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (error.code === "LANG_UNSUPPORTED" || error.code === "LANG_ARGUMENTS_INVALID") {
    language = (await resolveLanguagePreference().catch(() => ({ language: "en" }))).language;
  }
  const message = error.code === "LANG_UNSUPPORTED" || error.code === "LANG_ARGUMENTS_INVALID"
    ? formatLanguageError(error, language)
    : /^REMOTE_[A-Z_]+$/.test(error.code || "") ? error.code
      : translate(language, "remoteMaintenance.error", { usage: translate(language, "cli.usage.remoteMaintenance") });
  console.error(message);
  process.exitCode = 1;
}
