import path from "node:path";

const DRIVE_UNC_PREFIX = /^\\\\\?\\UNC\\/i;
const DRIVE_PREFIX = /^\\\\\?\\/;

// A \\?\ prefix hides the path's real identity, and Windows volumes fold case and treat
// both separators as equivalent, so all of that is applied before comparing.
function canonical(value) {
  return path.win32.resolve(String(value)).replace(DRIVE_UNC_PREFIX, "\\\\").replace(DRIVE_PREFIX, "").toLowerCase();
}

export const caseFold = value => String(value).toLowerCase();
export const comparisonKey = canonical;
export const samePath = (left, right) => canonical(left) === canonical(right);
export const isAbsolute = value => typeof value === "string" && path.win32.isAbsolute(value);
export const normalize = value => path.win32.normalize(String(value));

export function configFile({ env, home }) {
  return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "ThriftyRelay", "config.json");
}

export function taskDirectory({ env, home }) {
  return env.THRIFTYRELAY_TASK_DIR || path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "ThriftyRelay", "tasks");
}

// Temporary work belongs to the user's local cache, not to the checkout, the user's project,
// or the internal task store. LOCALAPPDATA is per-user and excluded from roaming profiles.
export function tempDirectory({ env, home }) {
  if (typeof env.THRIFTYRELAY_TEMP_DIR === "string" && path.win32.isAbsolute(env.THRIFTYRELAY_TEMP_DIR)) return env.THRIFTYRELAY_TEMP_DIR;
  const local = typeof env.LOCALAPPDATA === "string" && path.win32.isAbsolute(env.LOCALAPPDATA)
    ? env.LOCALAPPDATA
    : path.win32.join(home, "AppData", "Local");
  return path.win32.join(local, "ThriftyRelay", "temp");
}

export function executableLookup(name) {
  return { command: "where.exe", args: [name + ".exe"] };
}
