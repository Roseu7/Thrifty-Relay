import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathsAdapter } from "./platform/index.mjs";

const CONFIG_MODES = new Set(["on-login-task", "on-demand-task", "foreground", "manual"]);
const TUNNEL_ID = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/;
const SECRET_FIELD = /(?:api[_-]?key|admin[_-]?key|password|secret|(?:access|refresh)[_-]?token|authorization|credential)/i;
export const MIN_CODEX_AGENTS = 1;
export const DEFAULT_MAX_CODEX_AGENTS = 3;
export const MAX_CODEX_AGENTS = 5;
export const CODEX_MODEL_OPTIONS = Object.freeze([
  "gpt-6-luna/medium",
  "gpt-6-luna/high",
  "gpt-6-luna/max",
  "gpt-6.1-sol/medium",
  "gpt-6.1-sol/high",
  "gpt-6.1-terra/medium",
  "gpt-6.1-terra/high",
  "gpt-6.1-terra/max",
]);
export const UPPER_MODEL_OPTIONS = Object.freeze(["disabled", ...CODEX_MODEL_OPTIONS]);
export const REVIEW_POLICY_OPTIONS = Object.freeze(["conditional", "always", "manual"]);
export const QUOTA_LIMIT_ACTION_OPTIONS = Object.freeze(["warn", "block"]);
const QUOTA_LIMIT_PERCENT_FIELDS = Object.freeze(["fiveHourLimitPercent", "weeklyLimitPercent"]);
export const DEFAULT_SETTINGS = Object.freeze({
  language: "en",
  baseModel: "gpt-6-luna/max",
  upperModel: "gpt-6.1-sol/medium",
  maxCodexAgents: DEFAULT_MAX_CODEX_AGENTS,
  reviewPolicy: "conditional",
  fiveHourLimitPercent: 10,
  weeklyLimitPercent: 10,
  fiveHourLimitAction: "warn",
  weeklyLimitAction: "warn",
});
export const SETTINGS_FIELDS = Object.freeze([
  "language", "baseModel", "upperModel", "maxCodexAgents", "reviewPolicy",
  ...QUOTA_LIMIT_PERCENT_FIELDS, "fiveHourLimitAction", "weeklyLimitAction",
]);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function containsSecretField(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => SECRET_FIELD.test(key) || containsSecretField(nested));
}

export function validateSetupConfig(value, { platform = process.platform } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CONFIG_INVALID");
  if (Object.hasOwn(value, "language") && !["ja", "en"].includes(value.language)) fail("CONFIG_INVALID");
  if (Object.hasOwn(value, "baseModel") && !CODEX_MODEL_OPTIONS.includes(value.baseModel)) fail("CONFIG_INVALID");
  if (Object.hasOwn(value, "upperModel") && !UPPER_MODEL_OPTIONS.includes(value.upperModel)) fail("CONFIG_INVALID");
  if (Object.hasOwn(value, "reviewPolicy") && !REVIEW_POLICY_OPTIONS.includes(value.reviewPolicy)) fail("CONFIG_INVALID");
  if (QUOTA_LIMIT_PERCENT_FIELDS.some(field => Object.hasOwn(value, field) &&
      (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 100))) fail("CONFIG_INVALID");
  for (const field of ["fiveHourLimitAction", "weeklyLimitAction"]) {
    if (Object.hasOwn(value, field) && !QUOTA_LIMIT_ACTION_OPTIONS.includes(value[field])) fail("CONFIG_INVALID");
  }
  if (Object.hasOwn(value, "mode") && !CONFIG_MODES.has(value.mode)) fail("CONFIG_INVALID");
  if (Object.hasOwn(value, "mode")) {
    if (platform === "win32" && value.mode === "manual") fail("CONFIG_MODE_INVALID");
    if (platform !== "win32" && value.mode !== "manual") fail("CONFIG_MODE_INVALID");
  }
  if (Object.hasOwn(value, "maxCodexAgents") &&
      (!Number.isInteger(value.maxCodexAgents) || value.maxCodexAgents < MIN_CODEX_AGENTS ||
       value.maxCodexAgents > MAX_CODEX_AGENTS)) fail("CONFIG_INVALID");
  for (const field of ["workspace", "tunnelClientPath", "profileDir", "taskDirectory", "tempWorkspace", "packageRoot"]) {
    if (Object.hasOwn(value, field) && !pathsAdapter(platform).isAbsolute(value[field])) fail("CONFIG_INVALID");
  }
  if (Object.hasOwn(value, "tunnelId") &&
      (typeof value.tunnelId !== "string" || !TUNNEL_ID.test(value.tunnelId))) fail("CONFIG_INVALID");
  if (Object.hasOwn(value, "mode") && Object.hasOwn(value, "workspace") &&
      (!Object.hasOwn(value, "tunnelId") || !Object.hasOwn(value, "tunnelClientPath"))) fail("CONFIG_INVALID");
  if (containsSecretField(value)) fail("CONFIG_SECRET_FIELD_FORBIDDEN");
  return value;
}

export async function readSetupConfig(configFile, {
  readFile = fs.readFile,
  platform = process.platform,
} = {}) {
  let source;
  try { source = await readFile(configFile, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return {};
    fail("CONFIG_UNAVAILABLE");
  }
  let value;
  try { value = JSON.parse(String(source).replace(/^\uFEFF/, "")); }
  catch { fail("CONFIG_INVALID"); }
  return validateSetupConfig(value, { platform });
}

async function atomicWrite(file, text, { mkdir = fs.mkdir, writeFile = fs.writeFile, rename = fs.rename, rm = fs.rm } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function updateSetupConfig(configFile, patch, options = {}) {
  const { removeKeys = [], ...readOptions } = options;
  const current = await readSetupConfig(configFile, readOptions);
  const next = { ...current };
  for (const key of removeKeys) delete next[key];
  Object.assign(next, patch);
  const updated = validateSetupConfig(next, options);
  await atomicWrite(configFile, `${JSON.stringify(updated, null, 2)}\n`, options.filesystem);
  return updated;
}

export { CONFIG_MODES, TUNNEL_ID };
