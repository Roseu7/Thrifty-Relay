import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathsAdapter } from "../platform/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const languages = ["en", "ja"];
const catalogs = Object.fromEntries(languages.map(language => [
  language,
  JSON.parse(readFileSync(path.join(ROOT, "locales", `${language}.json`), "utf8")),
]));

export function validateLanguage(language) {
  if (!languages.includes(language)) {
    throw Object.assign(new Error("LANG_UNSUPPORTED"), { code: "LANG_UNSUPPORTED", languageValue: language });
  }
  return language;
}

export function languageFromLocale(locale) {
  const match = String(locale || "").trim().match(/^([a-z]{2,3})(?:[-_.@]|$)/i);
  const language = match?.[1].toLowerCase();
  return languages.includes(language) ? language : null;
}

function systemLocale() {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale) return locale;
  } catch {}
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
}

export function getConfigPath({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  // The override names a real file on this machine, so it resolves with host semantics.
  // Only the default location follows the platform's convention.
  if (env.THRIFTYRELAY_CONFIG_PATH) return path.resolve(env.THRIFTYRELAY_CONFIG_PATH);
  return pathsAdapter(platform).configFile({ env, home });
}

async function readConfig(configFile) {
  let contents;
  try { contents = await fs.readFile(configFile, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw Object.assign(new Error("LANG_CONFIG_UNAVAILABLE"), { code: "LANG_CONFIG_UNAVAILABLE" });
  }
  try {
    const config = JSON.parse(contents.replace(/^\uFEFF/, ""));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    return config;
  } catch {
    throw Object.assign(new Error("LANG_CONFIG_INVALID"), { code: "LANG_CONFIG_INVALID" });
  }
}

export async function getSavedLanguage(configFile = getConfigPath()) {
  const config = await readConfig(configFile);
  return languages.includes(config.language) ? config.language : null;
}

export async function resolveLanguagePreference({ explicitLanguage, configFile = getConfigPath(), osLocale = systemLocale() } = {}) {
  if (explicitLanguage !== undefined) return { language: validateLanguage(explicitLanguage), source: "explicit" };
  try {
    const saved = await getSavedLanguage(configFile);
    if (saved) return { language: saved, source: "saved" };
  } catch {
    // A broken preference must not prevent local maintenance commands from running.
  }
  const detected = languageFromLocale(osLocale);
  return detected
    ? { language: detected, source: "os" }
    : { language: "en", source: "fallback" };
}

export async function saveLanguage(language, configFile = getConfigPath()) {
  validateLanguage(language);
  if (!path.isAbsolute(configFile)) {
    throw Object.assign(new Error("LANG_CONFIG_PATH_INVALID"), { code: "LANG_CONFIG_PATH_INVALID" });
  }
  const config = await readConfig(configFile);
  config.language = language;
  const temporary = `${configFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, configFile);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function parseLanguageFlags(args) {
  const remaining = [];
  let explicitLanguage;
  let seen = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument !== "--lang" && !argument.startsWith("--lang=")) {
      remaining.push(argument);
      continue;
    }
    if (seen) throw Object.assign(new Error("LANG_ARGUMENTS_INVALID"), { code: "LANG_ARGUMENTS_INVALID" });
    seen = true;
    const value = argument === "--lang" ? args[++index] : argument.slice("--lang=".length);
    if (!value || value.startsWith("--")) {
      throw Object.assign(new Error("LANG_ARGUMENTS_INVALID"), { code: "LANG_ARGUMENTS_INVALID" });
    }
    explicitLanguage = validateLanguage(value);
  }
  return { args: remaining, explicitLanguage };
}

export function translate(language, key, values = {}) {
  const selected = catalogs[languages.includes(language) ? language : "en"];
  const template = selected[key] ?? catalogs.en[key] ?? key;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}

export function formatLanguageError(error, language = "en") {
  const key = error?.code === "LANG_UNSUPPORTED" ? "cli.language.unsupported"
    : error?.code === "LANG_ARGUMENTS_INVALID" ? "cli.language.invalidOption"
      : error?.code === "LANG_CONFIG_INVALID" ? "lang.error.invalidConfig"
        : error?.code === "LANG_CONFIG_UNAVAILABLE" || error?.code === "LANG_CONFIG_PATH_INVALID" ? "lang.error.config"
          : "cli.language.invalidOption";
  return `${error?.code || "LANG_ARGUMENTS_INVALID"}: ${translate(language, key)}`;
}

export function validateLocaleCatalogs(en = catalogs.en, ja = catalogs.ja) {
  const enKeys = Object.keys(en).sort();
  const jaKeys = Object.keys(ja).sort();
  if (enKeys.length !== jaKeys.length || enKeys.some((key, index) => key !== jaKeys[index])) {
    throw new Error("LOCALE_CATALOG_KEY_PARITY_FAILED");
  }
  for (const key of enKeys) {
    if (typeof en[key] !== "string" || typeof ja[key] !== "string") {
      throw new Error(`LOCALE_CATALOG_VALUE_INVALID:${key}`);
    }
    const placeholders = value => [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
    if (JSON.stringify(placeholders(en[key])) !== JSON.stringify(placeholders(ja[key]))) {
      throw new Error(`LOCALE_CATALOG_PLACEHOLDER_PARITY_FAILED:${key}`);
    }
  }
  return { keys: enKeys.length };
}

export { languages };
