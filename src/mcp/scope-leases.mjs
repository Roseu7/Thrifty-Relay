import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { writeRecord } from "./task-storage.mjs";
import { DEFAULT_MAX_CODEX_AGENTS, MAX_CODEX_AGENTS, readSetupConfig } from "../config.mjs";
import { getConfigPath } from "../i18n/index.mjs";
import { probeProcesses } from "./execution-guard.mjs";
import { resolvesWithoutLink } from "./record-identity.mjs";
import { pathsAdapter } from "../platform/index.mjs";

// Admission coordination only: callers must declare side effects; this is not an OS write sandbox.
const REGISTRY_VERSION = 1;
const CONTROL_VERSION = 1;
const BRIDGE_VERSION = 1;
const BRIDGE_TYPE = "scope_bridge";
const PATHS = pathsAdapter();
const sharedConfigNames = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "yarn.lock", "bun.lock", "bun.lockb", "vite.config.js", "vite.config.mjs", "vite.config.cjs",
  "vite.config.ts", "vite.config.mts", "vite.config.cts", "webpack.config.js", "webpack.config.cjs",
  "webpack.config.mjs", "webpack.config.ts", "rollup.config.js", "rollup.config.mjs", "rollup.config.cjs",
  "rollup.config.ts", "esbuild.config.js", "esbuild.config.mjs", "esbuild.config.ts", "tsconfig.json",
  "jsconfig.json", "babel.config.js", "babel.config.cjs", "babel.config.mjs", "postcss.config.js",
  "postcss.config.cjs", "postcss.config.mjs", "tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs",
  "next.config.js", "next.config.mjs", "next.config.ts", "astro.config.js", "astro.config.mjs",
  "astro.config.ts", "svelte.config.js", "nuxt.config.js", "nuxt.config.ts", "angular.json", "project.json",
  "nx.json", "turbo.json", "wrangler.toml", "wrangler.json", "wrangler.jsonc", "build.config.js",
  "build.config.mjs", "build.config.cjs", "build.config.ts", "tsup.config.js", "tsup.config.ts",
  "rspack.config.js", "rspack.config.ts", "farm.config.js", "parcel.config.js", "eslint.config.js",
  "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "jest.config.js", "jest.config.mjs",
  "jest.config.cjs", "vitest.config.js", "vitest.config.mjs", "vitest.config.ts", "playwright.config.js",
  "playwright.config.ts", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs"
]);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function samePath(left, right) {
  return PATHS.samePath(left, right);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateAbsoluteInput(value, code) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) fail(code);
}

function validateId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("REMOTE_SCOPE_INVALID");
  }
  return value;
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false;
  const millis = fraction.slice(0, 3).padEnd(3, "0");
  return Number.isFinite(Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${millis}${zone}`));
}

function normalizeOwner(owner) {
  if (!isPlainObject(owner) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      !validTimestamp(owner.started_at)) {
    fail("REMOTE_SCOPE_INVALID");
  }
  return { pid: owner.pid, started_at: owner.started_at };
}

function validateSegment(segment) {
  const lower = segment.toLowerCase();
  if (!segment || segment === "." || segment === ".." || /[ .]$/.test(segment) ||
      /[<>:"|?*!\[\]{}\\/\u0000-\u001f\u007f]/.test(segment) ||
      lower === ".git" || lower === "node_modules" ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i.test(segment)) {
    fail("REMOTE_SCOPE_INVALID");
  }
}

function isSharedConfigPath(relativePath) {
  const name = relativePath.split("/").at(-1).toLowerCase();
  return sharedConfigNames.has(name) ||
    /^tsconfig(?:\.[^/]+)?\.json$/.test(name) || /^jsconfig(?:\.[^/]+)?\.json$/.test(name) ||
    /^(?:\.babelrc|\.eslintrc|\.prettierrc)(?:\..*)?$/.test(name) ||
    /^(?:build|vite|webpack|rollup|esbuild|tsup|rspack|farm|parcel|babel|postcss|tailwind|next|astro|svelte|nuxt|wrangler|eslint|jest|vitest|playwright|prettier)\.config\.[^/]+$/.test(name);
}

function normalizeScopePath(value) {
  if (typeof value !== "string" || !value || value.length > 240 || value.startsWith("/") || value.startsWith("\\")) {
    fail("REMOTE_SCOPE_INVALID");
  }
  const parts = value.replace(/\\/g, "/").split("/");
  for (const part of parts) validateSegment(part);
  const normalized = parts.join("/");
  if (isSharedConfigPath(normalized)) fail("REMOTE_SCOPE_INVALID");
  return { path: normalized, key: PATHS.caseFold(normalized) };
}

function normalizeScopes(kind, scopes) {
  if (kind === "remote") return { global: true, scopes: [] };
  if (kind !== "codex") fail("REMOTE_SCOPE_INVALID");

  if (scopes === "global" || (isPlainObject(scopes) && scopes.kind === "global") ||
      (Array.isArray(scopes) && scopes.length === 1 && isPlainObject(scopes[0]) && scopes[0].kind === "global")) {
    return { global: true, scopes: [] };
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 100) fail("REMOTE_SCOPE_INVALID");

  const normalized = [];
  const seen = new Set();
  for (const scope of scopes) {
    if (!isPlainObject(scope) || !["file", "directory"].includes(scope.kind) ||
        Object.keys(scope).some(key => !["kind", "path"].includes(key))) fail("REMOTE_SCOPE_INVALID");
    const item = normalizeScopePath(scope.path);
    const key = `${scope.kind}:${item.key}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ kind: scope.kind, path: item.path });
    }
  }
  return { global: false, scopes: normalized };
}

function isScopePathValid(kind, relativePath) {
  if (!isPlainObject(kind) || !["file", "directory"].includes(kind.kind)) return false;
  try {
    return normalizeScopePath(relativePath).path === relativePath;
  } catch {
    return false;
  }
}

function scopeIntersects(left, right) {
  const a = { ...left, key: PATHS.caseFold(left.path) };
  const b = { ...right, key: PATHS.caseFold(right.path) };
  const contains = (directory, candidate) => candidate === directory || candidate.startsWith(`${directory}/`);
  if (a.kind === "directory" && b.kind === "directory") return contains(a.key, b.key) || contains(b.key, a.key);
  if (a.kind === "directory") return contains(a.key, b.key);
  if (b.kind === "directory") return contains(b.key, a.key);
  return a.key === b.key;
}

function looksLikeReparsePoint(stats, file) {
  return stats.isSymbolicLink() || !resolvesWithoutLink(file);
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function verifyPathComponent(file, expectedKind) {
  const stats = await fs.lstat(file);
  if (stats.isSymbolicLink()) fail("REMOTE_SCOPE_UNVERIFIED");
  if (await looksLikeReparsePoint(stats, file)) fail("REMOTE_SCOPE_UNVERIFIED");
  if (expectedKind === "directory" && !stats.isDirectory()) fail("REMOTE_SCOPE_UNVERIFIED");
  if (expectedKind === "file" && (!stats.isFile() || stats.nlink > 1)) fail("REMOTE_SCOPE_UNVERIFIED");
  return stats;
}

async function verifyDirectoryTree(workspace, directory, relativeParts) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const childParts = [...relativeParts, entry.name];
    const relativePath = childParts.join("/");
    const lowerName = entry.name.toLowerCase();
    if (lowerName === ".git" || lowerName === "node_modules") fail("REMOTE_SCOPE_INVALID");
    if (isSharedConfigPath(relativePath)) fail("REMOTE_SCOPE_INVALID");
    const child = path.join(directory, entry.name);
    if (!isWithin(workspace, child)) fail("REMOTE_SCOPE_UNVERIFIED");
    const stats = await verifyPathComponent(child, "any");
    if (stats.isDirectory()) {
      await verifyDirectoryTree(workspace, child, childParts);
    } else if (!stats.isFile() || stats.nlink > 1) {
      fail("REMOTE_SCOPE_UNVERIFIED");
    }
  }
}

async function verifyScopes(workspace, scopes) {
  try {
    for (const scope of scopes) {
      const parts = scope.path.split("/");
      let current = workspace;
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        if (!isWithin(workspace, current)) fail("REMOTE_SCOPE_INVALID");
        const stats = await lstatOrNull(current);
        if (!stats) {
          if (scope.kind === "file" && index === parts.length - 1) break;
          fail("REMOTE_SCOPE_UNVERIFIED");
        }
        const expectedKind = index === parts.length - 1 ? scope.kind : "directory";
        await verifyPathComponent(current, expectedKind);
        if (index === parts.length - 1 && scope.kind === "directory") {
          await verifyDirectoryTree(workspace, current, parts);
        }
      }
    }
  } catch (error) {
    if (error?.code?.startsWith("REMOTE_")) throw error;
    fail("REMOTE_SCOPE_UNVERIFIED");
  }
}

// Read-only preflight, before request tombstones or lease-store initialization.
export async function validateWriteScopes(workspace, scopes) {
  if (scopes !== "global" && !Array.isArray(scopes)) fail("REMOTE_SCOPE_INVALID");
  if (Array.isArray(scopes) && scopes.some(scope => !["file", "directory"].includes(scope?.kind))) fail("REMOTE_SCOPE_INVALID");
  const requested = normalizeScopes("codex", scopes);
  if (!requested.global) await verifyScopes(workspace, requested.scopes);
  return requested;
}

function validProcess(row) {
  return isPlainObject(row) && Number.isSafeInteger(row.pid) && row.pid > 0 &&
    (row.pending === true || validTimestamp(row.observed_absent_at) ||
      (validTimestamp(row.started_at) && Number.isSafeInteger(row.parent_pid) && row.parent_pid >= 0));
}

async function realDirectory(input, errorCode) {
  try {
    const resolved = await fs.realpath(input);
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) fail(errorCode);
    return path.resolve(resolved);
  } catch (error) {
    if (error?.code?.startsWith("REMOTE_")) throw error;
    fail(errorCode);
  }
}

function validateControl(record) {
  if (!isPlainObject(record) || record.version !== CONTROL_VERSION ||
      typeof record.namespace !== "string" || !record.namespace.trim() || record.namespace.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(record.namespace)) fail("REMOTE_REGISTRY_UNAVAILABLE");
  return record;
}

function validateRegistry(record, control, workspace) {
  if (!isPlainObject(record) || record.version !== REGISTRY_VERSION ||
      record.namespace !== control.namespace || typeof record.workspace !== "string" ||
      !path.isAbsolute(record.workspace) || !samePath(record.workspace, workspace) ||
      !Array.isArray(record.leases) || record.leases.length > MAX_CODEX_AGENTS) {
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
  if (record.bridge !== undefined && record.bridge !== null &&
      (!isPlainObject(record.bridge) || typeof record.bridge.token !== "string" ||
       !record.bridge.token || record.bridge.token.length > 256 ||
       typeof record.bridge.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.bridge.fingerprint))) {
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
  if (record.leases.length > 0 && !record.bridge) fail("REMOTE_REGISTRY_UNAVAILABLE");
  const tokens = new Set();
  const requests = new Set();
  const conversations = new Set();
  for (const lease of record.leases) {
    if (!isPlainObject(lease) || typeof lease.token !== "string" || !lease.token || lease.token.length > 256 ||
        typeof lease.task_id !== "string" || !lease.task_id.trim() || lease.task_id.length > 1024 ||
        typeof lease.request_id !== "string" || !lease.request_id.trim() || lease.request_id.length > 1024 ||
        typeof lease.conversation_id !== "string" || !lease.conversation_id.trim() || lease.conversation_id.length > 1024 ||
        /[\u0000-\u001f\u007f]/.test(lease.task_id + lease.request_id + lease.conversation_id) ||
        !["codex", "remote"].includes(lease.kind) ||
        !isPlainObject(lease.owner) || !Number.isSafeInteger(lease.owner.pid) || lease.owner.pid < 1 ||
        !validTimestamp(lease.owner.started_at) ||
        typeof lease.global !== "boolean" || !Array.isArray(lease.scopes) ||
        !["running", "unknown"].includes(lease.state) || typeof lease.acquired_at !== "string" ||
        !validTimestamp(lease.acquired_at) || (lease.kind === "remote" && !lease.global)) {
      fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
    const requestKey = lease.request_id;
    if (lease.processes !== undefined && (!Array.isArray(lease.processes) || !lease.processes.every(validProcess))) {
      fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
    if (tokens.has(lease.token) || requests.has(requestKey) || conversations.has(lease.conversation_id)) {
      fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
    tokens.add(lease.token);
    requests.add(requestKey);
    conversations.add(lease.conversation_id);
    if (lease.global && lease.scopes.length || !lease.global && (lease.kind !== "codex" || !lease.scopes.length)) {
      fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
    for (const scope of lease.scopes) {
      if (!isPlainObject(scope) || !isScopePathValid(scope, scope.path)) fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
    if (lease.state === "unknown" && (typeof lease.reason !== "string" || !lease.reason.trim() || lease.reason.length > 2048)) {
      fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
  }
  for (let leftIndex = 0; leftIndex < record.leases.length; leftIndex++) {
    const left = record.leases[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < record.leases.length; rightIndex++) {
      const right = record.leases[rightIndex];
      if (left.global || right.global || left.scopes.some(a => right.scopes.some(b => scopeIntersects(a, b)))) {
        fail("REMOTE_REGISTRY_UNAVAILABLE");
      }
    }
  }
  return record;
}

async function readJsonRecord(file, expectedType) {
  try {
    const stats = await fs.lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) fail("REMOTE_REGISTRY_UNAVAILABLE");
    if (!(await resolvesWithoutLink(file))) fail("REMOTE_REGISTRY_UNAVAILABLE");
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isPlainObject(parsed)) fail("REMOTE_REGISTRY_UNAVAILABLE");
    return expectedType(parsed);
  } catch (error) {
    if (error?.code?.startsWith("REMOTE_")) throw error;
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
}

async function readJsonSnapshot(file, expectedType) {
  try {
    const before = await fs.lstat(file);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1 || !(await resolvesWithoutLink(file))) {
      fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
    const bytes = await fs.readFile(file);
    const after = await fs.lstat(file);
    if (!sameFileIdentity(before, after) || bytes.length !== after.size || !(await resolvesWithoutLink(file))) {
      fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!isPlainObject(parsed)) fail("REMOTE_REGISTRY_UNAVAILABLE");
    return { record: expectedType(parsed), sha256: sha256(bytes) };
  } catch (error) {
    if (error?.code?.startsWith("REMOTE_")) throw error;
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
}

async function readActiveLock(store) {
  const file = path.join(store, "active.lock");
  try {
    const before = await lstatOrNull(file);
    if (!before) return null;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1 || !(await resolvesWithoutLink(file))) {
      fail("REMOTE_REGISTRY_UNAVAILABLE");
    }
    const bytes = await fs.readFile(file);
    const after = await fs.lstat(file);
    if (!sameFileIdentity(before, after) || bytes.length !== after.size ||
        !(await resolvesWithoutLink(file))) fail("REMOTE_REGISTRY_UNAVAILABLE");
    let record = null;
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (isPlainObject(parsed)) record = parsed;
    } catch {}
    return { file, stats: after, bytes, fingerprint: sha256(bytes), record };
  } catch (error) {
    if (error?.code?.startsWith("REMOTE_")) throw error;
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
}

function assertBridgeMatches(active, registry, control, workspace) {
  const bridge = registry.bridge;
  const record = active?.record;
  if (!bridge || !active || active.fingerprint !== bridge.fingerprint || !record ||
      record.version !== BRIDGE_VERSION || record.type !== BRIDGE_TYPE ||
      record.namespace !== control.namespace || record.token !== bridge.token ||
      typeof record.workspace !== "string" || !samePath(record.workspace, workspace) ||
      !validTimestamp(record.acquired_at)) fail("REMOTE_REGISTRY_UNAVAILABLE");
  return active;
}

async function createBridge(store, control, workspace) {
  const file = path.join(store, "active.lock");
  const record = {
    version: BRIDGE_VERSION,
    type: BRIDGE_TYPE,
    namespace: control.namespace,
    workspace,
    token: randomUUID(),
    acquired_at: new Date().toISOString()
  };
  const bytes = Buffer.from(JSON.stringify(record));
  let handle;
  try {
    // Competes atomically with legacy active-lock creators that still use exclusive publication.
    handle = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail("REMOTE_GLOBAL_LOCKED");
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
  let writeError;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    writeError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    writeError ||= error;
  }
  if (writeError) fail("REMOTE_REGISTRY_UNAVAILABLE");
  const active = await readActiveLock(store);
  const metadata = { token: record.token, fingerprint: sha256(bytes) };
  assertBridgeMatches(active, { bridge: metadata }, control, workspace);
  return metadata;
}

async function removeBridge(store, bridge, control, workspace) {
  const first = assertBridgeMatches(await readActiveLock(store), { bridge }, control, workspace);
  const current = assertBridgeMatches(await readActiveLock(store), { bridge }, control, workspace);
  if (!sameFileIdentity(first.stats, current.stats) || first.fingerprint !== current.fingerprint) {
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
  const pathStats = await fs.lstat(current.file);
  if (!sameFileIdentity(current.stats, pathStats) || pathStats.isSymbolicLink() || !pathStats.isFile() ||
      pathStats.nlink > 1 || !(await resolvesWithoutLink(current.file))) {
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
  try {
    await fs.unlink(current.file);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
  if (await lstatOrNull(current.file)) fail("REMOTE_REGISTRY_UNAVAILABLE");
  return current.bytes;
}

async function restoreBridge(store, bytes, bridge, control, workspace) {
  let handle;
  try {
    handle = await fs.open(path.join(store, "active.lock"), "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return;
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
  let writeError;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    writeError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    writeError ||= error;
  }
  if (writeError) fail("REMOTE_REGISTRY_UNAVAILABLE");
  assertBridgeMatches(await readActiveLock(store), { bridge }, control, workspace);
}

async function writeExclusive(file, record) {
  try {
    await writeRecord(file, record, true);
  } catch (error) {
    if (error.code !== "EEXIST") fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
}

async function ensureStore(store) {
  try {
    await fs.mkdir(store);
  } catch (error) {
    if (error.code !== "EEXIST") fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
  try {
    const stats = await fs.lstat(store);
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail("REMOTE_REGISTRY_UNAVAILABLE");
    if (!(await resolvesWithoutLink(store))) fail("REMOTE_REGISTRY_UNAVAILABLE");
  } catch (error) {
    if (error?.code?.startsWith("REMOTE_")) throw error;
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
}

export async function withAdmissionGate(store, callback) {
  const gate = path.join(store, "admission.lock");
  let held = false;
  let identity;
  try {
    // A concurrent admission holds this directory briefly. Wait for its atomic
    // registry update; a crashed holder remains blocked for guided recovery.
    const deadline = Date.now() + 3000;
    while (!held) {
      try {
        await fs.mkdir(gate);
        held = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) fail("REMOTE_REGISTRY_UNAVAILABLE");
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    }
    try {
      identity = await fs.lstat(gate);
    } catch (error) {
      await fs.rmdir(gate).catch(() => {});
      held = false;
      throw error;
    }
    return await callback();
  } catch (error) {
    if (error?.code?.startsWith("REMOTE_")) throw error;
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  } finally {
    if (held) {
      try {
        const current = await fs.lstat(gate);
        if (identity && (current.dev !== identity.dev || current.ino !== identity.ino) || !current.isDirectory()) {
          fail("REMOTE_REGISTRY_UNAVAILABLE");
        }
        await fs.rmdir(gate);
      } catch (error) {
        if (error?.code?.startsWith("REMOTE_")) throw error;
        fail("REMOTE_REGISTRY_UNAVAILABLE");
      }
    }
  }
}

async function legacyLocks(store) {
  try {
    return {
      active: !!(await lstatOrNull(path.join(store, "active.lock"))),
      maintenance: !!(await lstatOrNull(path.join(store, "maintenance.lock")))
    };
  } catch {
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }
}

async function loadState(store, workspace, initialize) {
  const controlFile = path.join(store, "coordination.json");
  const registryFile = path.join(store, "leases.json");
  let controlStat;
  let registryStat;
  try {
    controlStat = await lstatOrNull(controlFile);
    registryStat = await lstatOrNull(registryFile);
  } catch {
    fail("REMOTE_REGISTRY_UNAVAILABLE");
  }

  if (!controlStat) {
    if (!initialize || registryStat) fail("REMOTE_REGISTRY_UNAVAILABLE");
    await writeExclusive(controlFile, { version: CONTROL_VERSION, namespace: randomUUID(), enabled_at: new Date().toISOString() });
  }
  const control = await readJsonRecord(controlFile, validateControl);

  if (!registryStat) {
    if (!initialize) fail("REMOTE_REGISTRY_UNAVAILABLE");
    await writeExclusive(registryFile, { version: REGISTRY_VERSION, namespace: control.namespace, workspace, bridge: null, leases: [] });
  }
  const registry = await readJsonRecord(registryFile, record => validateRegistry(record, control, workspace));
  return { control, registry, registryFile };
}

function validateLeaseIdentity(lease) {
  if (!isPlainObject(lease) || typeof lease.token !== "string" || !lease.token) fail("REMOTE_SCOPE_INVALID");
  validateId(lease.task_id);
  validateId(lease.request_id);
  validateId(lease.conversation_id);
  return { ...lease, owner: normalizeOwner(lease.owner) };
}

function sameLeaseIdentity(candidate, record) {
  return candidate.token === record.token && candidate.task_id === record.task_id &&
    candidate.request_id === record.request_id && candidate.conversation_id === record.conversation_id &&
    candidate.kind === record.kind && candidate.owner.pid === record.owner.pid &&
    candidate.owner.started_at === record.owner.started_at;
}

function leaseHandle(record) {
  return Object.freeze({
    token: record.token,
    task_id: record.task_id,
    request_id: record.request_id,
    conversation_id: record.conversation_id,
    kind: record.kind,
    owner: Object.freeze({ ...record.owner })
  });
}

function snapshotSummary(registry, legacy, admissionLocked, maxLeases, scopeBridge = false) {
  const unknownCount = registry.leases.filter(lease => lease.state === "unknown").length;
  const globalLease = registry.leases.some(lease => lease.global);
  const globalLocked = legacy.active || legacy.maintenance || admissionLocked || unknownCount > 0 || globalLease;
  return {
    status: legacy.active || legacy.maintenance ? "legacy_locked" : admissionLocked ? "admission_locked" : unknownCount ? "unknown" : globalLease ? "global_locked" : registry.leases.length ? "active" : "ready",
    lease_count: registry.leases.length,
    max_leases: maxLeases,
    unknown_count: unknownCount,
    global_locked: globalLocked,
    scope_bridge: scopeBridge,
    admission_locked: admissionLocked,
    legacy: { active_lock: legacy.active, maintenance_lock: legacy.maintenance },
    leases: registry.leases.map(lease => ({
      task_id: lease.task_id,
      request_id: lease.request_id,
      conversation_id: lease.conversation_id,
      owner: lease.owner,
      acquired_at: lease.acquired_at,
      scopes: lease.scopes,
      processes: lease.processes || [],
      kind: lease.kind,
      state: lease.state,
      global: lease.global,
      scope_count: lease.scopes.length
    }))
  };
}

async function inspectState(store, workspace, maxLeases) {
  const storeStat = await lstatOrNull(store);
  if (!storeStat) {
    return { status: "uninitialized", lease_count: 0, max_leases: maxLeases, unknown_count: 0, global_locked: false,
      scope_bridge: false, admission_locked: false, legacy: { active_lock: false, maintenance_lock: false }, leases: [] };
  }
  if (storeStat.isSymbolicLink() || !storeStat.isDirectory()) fail("REMOTE_REGISTRY_UNAVAILABLE");
  const locks = await legacyLocks(store);
  const active = await readActiveLock(store);
  const legacy = { active: !!active, maintenance: locks.maintenance };
  const admissionLocked = !!(await lstatOrNull(path.join(store, "admission.lock")));
  const controlStat = await lstatOrNull(path.join(store, "coordination.json"));
  const registryStat = await lstatOrNull(path.join(store, "leases.json"));
  if (!controlStat && !registryStat) {
    if (active?.record?.type === BRIDGE_TYPE) fail("REMOTE_REGISTRY_UNAVAILABLE");
    return {
      status: legacy.active || legacy.maintenance ? "legacy_locked" : admissionLocked ? "admission_locked" : "uninitialized",
      lease_count: 0, max_leases: maxLeases, unknown_count: 0,
      global_locked: legacy.active || legacy.maintenance || admissionLocked,
      scope_bridge: false,
      admission_locked: admissionLocked,
      legacy: { active_lock: legacy.active, maintenance_lock: legacy.maintenance }, leases: []
    };
  }
  if (!controlStat || !registryStat) fail("REMOTE_REGISTRY_UNAVAILABLE");
  const control = await readJsonRecord(path.join(store, "coordination.json"), validateControl);
  const registry = await readJsonRecord(path.join(store, "leases.json"), record => validateRegistry(record, control, workspace));
  if (registry.leases.length) {
    assertBridgeMatches(active, registry, control, workspace);
    return snapshotSummary(registry, { ...legacy, active: false }, admissionLocked, maxLeases, true);
  }
  if (registry.bridge) {
    if (active) assertBridgeMatches(active, registry, control, workspace);
    return {
      status: "unavailable", code: "REMOTE_REGISTRY_UNAVAILABLE", lease_count: 0, max_leases: maxLeases,
      unknown_count: 0, global_locked: true, scope_bridge: !!active,
      admission_locked: admissionLocked,
      legacy: { active_lock: false, maintenance_lock: legacy.maintenance }, leases: []
    };
  }
  if (active?.record?.type === BRIDGE_TYPE) fail("REMOTE_REGISTRY_UNAVAILABLE");
  return snapshotSummary(registry, legacy, admissionLocked, maxLeases);
}

export function createScopedLeaseRegistry({ dir, workspace, configFile = getConfigPath(), platform = process.platform } = {}) {
  validateAbsoluteInput(dir, "REMOTE_REGISTRY_UNAVAILABLE");
  validateAbsoluteInput(workspace, "REMOTE_SCOPE_UNVERIFIED");

  async function resolveContext() {
    const [taskDir, workspaceDir] = await Promise.all([
      realDirectory(dir, "REMOTE_REGISTRY_UNAVAILABLE"),
      realDirectory(workspace, "REMOTE_SCOPE_UNVERIFIED")
    ]);
    return { taskDir, workspace: workspaceDir, store: path.join(taskDir, "codex") };
  }

  async function assertContextStable(before) {
    const after = await resolveContext();
    if (!samePath(before.taskDir, after.taskDir)) fail("REMOTE_REGISTRY_UNAVAILABLE");
    if (!samePath(before.workspace, after.workspace)) fail("REMOTE_SCOPE_UNVERIFIED");
  }

  async function readMaxLeases() {
    try {
      const config = await readSetupConfig(configFile, { platform });
      return config.maxCodexAgents ?? DEFAULT_MAX_CODEX_AGENTS;
    } catch {
      fail("REMOTE_LEASE_CONFIG_UNAVAILABLE");
    }
  }

  async function recoverySnapshot() {
    const context = await resolveContext();
    const controlFile = path.join(context.store, "coordination.json");
    const registryFile = path.join(context.store, "leases.json");
    const controlSnapshot = await readJsonSnapshot(controlFile, validateControl);
    const registrySnapshot = await readJsonSnapshot(registryFile,
      record => validateRegistry(record, controlSnapshot.record, context.workspace));
    const [active, locks, controlAfter] = await Promise.all([
      readActiveLock(context.store), legacyLocks(context.store), readJsonSnapshot(controlFile, validateControl)
    ]);
    if (controlAfter.sha256 !== controlSnapshot.sha256) fail("REMOTE_LOCK_CHANGED");
    if (locks.maintenance) fail("REMOTE_MAINTENANCE_LOCKED_INSPECT_REQUIRED");
    if (!registrySnapshot.record.leases.length || !registrySnapshot.record.bridge) fail("REMOTE_REGISTRY_UNAVAILABLE");
    assertBridgeMatches(active, registrySnapshot.record, controlSnapshot.record, context.workspace);
    await assertContextStable(context);
    return {
      workspace: context.workspace,
      control: controlSnapshot.record,
      registry: registrySnapshot.record,
      namespace: controlSnapshot.record.namespace,
      control_sha256: controlSnapshot.sha256,
      registry_sha256: registrySnapshot.sha256,
      bridge_sha256: active.fingerprint,
      bridge_token: registrySnapshot.record.bridge.token,
      leases: registrySnapshot.record.leases.map(lease => ({ ...lease, owner: { ...lease.owner },
        processes: (lease.processes || []).map(row => ({ ...row })) })),
    };
  }

  function assertExpectedRecoverySnapshot(actual, expected, taskId, leaseId) {
    if (!expected || actual.namespace !== expected.namespace || actual.control_sha256 !== expected.control_sha256 ||
        actual.registry_sha256 !== expected.registry_sha256 || actual.bridge_sha256 !== expected.bridge_sha256 ||
        actual.bridge_token !== expected.bridge_token) fail("REMOTE_LOCK_CHANGED");
    const lease = actual.leases.find(item => item.token === leaseId);
    const previous = expected.leases?.find(item => item.token === leaseId);
    if (!lease || !previous || lease.task_id !== taskId || previous.task_id !== taskId ||
        !["unknown", "running"].includes(lease.state) || lease.state !== previous.state ||
        !sameLeaseIdentity(previous, lease)) fail("REMOTE_LOCK_CHANGED");
    if (actual.leases.length !== 1) fail("REMOTE_SCOPED_OTHER_LEASES_ACTIVE");
    return lease;
  }

  async function recoverSelectedLease({ task_id, lease_id, expected, beforeRelease, onReleaseStart } = {}) {
    validateId(task_id);
    if (typeof lease_id !== "string" || !lease_id || lease_id.length > 256 ||
        typeof beforeRelease !== "function") fail("REMOTE_APPROVAL_INVALID");
    const context = await resolveContext();
    let releaseMutationStarted = false;
    return await withAdmissionGate(context.store, async () => {
      try {
        await assertContextStable(context);
        const initial = await recoverySnapshot();
        const lease = assertExpectedRecoverySnapshot(initial, expected, task_id, lease_id);
        await beforeRelease(lease);

        // User review stays outside the gate. Recheck shared files after the
        // final process/metadata review and before changing the registry.
        await assertContextStable(context);
        const current = await recoverySnapshot();
        const currentLease = assertExpectedRecoverySnapshot(current, expected, task_id, lease_id);
        if (!sameLeaseIdentity(lease, currentLease)) fail("REMOTE_LOCK_CHANGED");

        const registryFile = path.join(context.store, "leases.json");
        await onReleaseStart?.();
        const releaseState = await recoverySnapshot();
        const releaseLease = assertExpectedRecoverySnapshot(releaseState, expected, task_id, lease_id);
        if (!sameLeaseIdentity(lease, releaseLease)) fail("REMOTE_LOCK_CHANGED");
        const control = releaseState.control;
        const registry = { ...releaseState.registry, leases: [] };
        releaseMutationStarted = true;
        await writeRecord(registryFile, registry);
        let bridgeBytes;
        try {
          bridgeBytes = await removeBridge(context.store, registry.bridge, control, context.workspace);
          registry.bridge = null;
          await writeRecord(registryFile, registry);
        } catch (error) {
          if (bridgeBytes) {
            try { await restoreBridge(context.store, bridgeBytes, { token: current.bridge_token, fingerprint: current.bridge_sha256 }, control, context.workspace); }
            catch { /* A failed restoration remains a blocking, auditable partial state. */ }
          }
          throw error;
        }
        const [finalRegistry, finalControl, finalBridge] = await Promise.all([
          readJsonSnapshot(registryFile, record => validateRegistry(record, control, context.workspace)),
          readJsonSnapshot(path.join(context.store, "coordination.json"), validateControl),
          readActiveLock(context.store)
        ]);
        if (finalRegistry.record.leases.length || finalRegistry.record.bridge || finalBridge ||
            finalControl.record.namespace !== current.namespace || finalControl.sha256 !== current.control_sha256) {
          fail("REMOTE_REGISTRY_UNAVAILABLE");
        }
        return { released: true, task_id, lease_id };
      } catch (error) {
        if (!error.recovery_lock_state) {
          try {
            const state = await recoverySnapshot();
            error.recovery_lock_state = state.leases.some(item => item.token === lease_id) ? "retained" :
              releaseMutationStarted ? "partial" : "retained";
          } catch { error.recovery_lock_state = releaseMutationStarted ? "unknown" : "retained"; }
        }
        throw error;
      }
    });
  }

  async function acquire({ task_id, request_id, conversation_id, scopes, kind, owner } = {}) {
    const task = validateId(task_id);
    const request = validateId(request_id);
    const conversation = validateId(conversation_id);
    const processOwner = normalizeOwner(owner);
    const requested = normalizeScopes(kind, scopes);
    // Fail closed before creating the lease store, then reread under the admission gate.
    await readMaxLeases();
    const context = await resolveContext();
    if (!requested.global) await verifyScopes(context.workspace, requested.scopes);
    await ensureStore(context.store);

    return await withAdmissionGate(context.store, async () => {
      await assertContextStable(context);
      const maxLeases = await readMaxLeases();
      const legacy = await legacyLocks(context.store);
      if (legacy.maintenance) fail("REMOTE_GLOBAL_LOCKED");
      const registryStat = await lstatOrNull(path.join(context.store, "leases.json"));
      if (legacy.active && !registryStat) fail("REMOTE_GLOBAL_LOCKED");
      const { control, registry, registryFile } = await loadState(context.store, context.workspace, !legacy.active);
      const active = await readActiveLock(context.store);
      if (registry.leases.length) {
        assertBridgeMatches(active, registry, control, context.workspace);
      } else {
        if (registry.bridge) fail("REMOTE_REGISTRY_UNAVAILABLE");
        if (active) {
          if (active.record?.type === BRIDGE_TYPE) fail("REMOTE_REGISTRY_UNAVAILABLE");
          fail("REMOTE_GLOBAL_LOCKED");
        }
      }

      if (registry.leases.some(lease => lease.state === "unknown")) fail("REMOTE_GLOBAL_LOCKED");
      if (registry.leases.some(lease => lease.request_id === request) ||
          registry.leases.some(lease => lease.conversation_id === conversation)) fail("REMOTE_SESSION_BUSY");
      if (registry.leases.some(lease => lease.global)) fail("REMOTE_GLOBAL_LOCKED");
      if (requested.global ? registry.leases.length > 0 :
          registry.leases.some(lease => lease.scopes.some(existing => requested.scopes.some(next => scopeIntersects(existing, next))))) {
        fail("REMOTE_SCOPE_CONFLICT");
      }
      if (registry.leases.length >= maxLeases) fail("REMOTE_LEASE_LIMIT");
      if (!registry.leases.length) {
        registry.bridge = await createBridge(context.store, control, context.workspace);
      }

      const record = {
        token: randomUUID(), task_id: task, request_id: request, conversation_id: conversation,
        kind, owner: processOwner, global: requested.global, scopes: requested.scopes,
        acquired_at: new Date().toISOString(), state: "running", processes: []
      };
      registry.leases.push(record);
      try {
        await writeRecord(registryFile, registry);
      } catch {
        fail("REMOTE_REGISTRY_UNAVAILABLE");
      }
      return leaseHandle(record);
    });
  }

  async function updateLease(lease, update) {
    const candidate = validateLeaseIdentity(lease);
    const context = await resolveContext();
    await ensureStore(context.store);
    return await withAdmissionGate(context.store, async () => {
      await assertContextStable(context);
      const { control, registry, registryFile } = await loadState(context.store, context.workspace, false);
      assertBridgeMatches(await readActiveLock(context.store), registry, control, context.workspace);
      const index = registry.leases.findIndex(record => record.token === candidate.token);
      if (index < 0 || !sameLeaseIdentity(candidate, registry.leases[index])) fail("REMOTE_REGISTRY_UNAVAILABLE");
      update(registry, index);
      try {
        await writeRecord(registryFile, registry);
      } catch {
        fail("REMOTE_REGISTRY_UNAVAILABLE");
      }
    });
  }

  async function release(lease) {
    const candidate = validateLeaseIdentity(lease);
    const context = await resolveContext();
    await ensureStore(context.store);
    return await withAdmissionGate(context.store, async () => {
      await assertContextStable(context);
      const { control, registry, registryFile } = await loadState(context.store, context.workspace, false);
      assertBridgeMatches(await readActiveLock(context.store), registry, control, context.workspace);
      const index = registry.leases.findIndex(record => record.token === candidate.token);
      if (index < 0 || !sameLeaseIdentity(candidate, registry.leases[index])) fail("REMOTE_REGISTRY_UNAVAILABLE");
      // Unknown effects require guided, audited recovery rather than ordinary release.
      if (registry.leases[index].state === "unknown") fail("REMOTE_GLOBAL_LOCKED");
      registry.leases.splice(index, 1);
      try {
        await writeRecord(registryFile, registry);
      } catch {
        fail("REMOTE_REGISTRY_UNAVAILABLE");
      }
      if (registry.leases.length) return;

      // Keep the bridge recorded until after unlink; restore it if the final registry write fails.
      const bridge = registry.bridge;
      let bridgeBytes;
      try {
        bridgeBytes = await removeBridge(context.store, bridge, control, context.workspace);
      } catch {
        fail("REMOTE_REGISTRY_UNAVAILABLE");
      }
      registry.bridge = null;
      try {
        await writeRecord(registryFile, registry);
      } catch {
        try {
          await restoreBridge(context.store, bridgeBytes, bridge, control, context.workspace);
        } catch {
          fail("REMOTE_REGISTRY_UNAVAILABLE");
        }
        fail("REMOTE_REGISTRY_UNAVAILABLE");
      }
    });
  }

  async function retain(lease, reason) {
    if (typeof reason !== "string" || !reason.trim() || reason.length > 2048 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
      fail("REMOTE_SCOPE_INVALID");
    }
    const safeReason = reason.replace(/[\r\n\t]+/g, " ").trim();
    await updateLease(lease, (registry, index) => {
      registry.leases[index].state = "unknown";
      registry.leases[index].reason = safeReason;
    });
  }

  async function noteProcess(lease, pid, descendants = false) {
    if (!Number.isSafeInteger(pid) || pid < 1 || typeof descendants !== "boolean") fail("REMOTE_SCOPE_INVALID");
    let previousProcess;
    // Persist the PID before slow enumeration, so a crash/probe failure cannot erase it.
    await updateLease(lease, (registry, index) => {
      const record = registry.leases[index];
      record.processes ||= [];
      previousProcess = record.processes.find(row => row.pid === pid && row.started_at);
      if (!record.processes.some(row => row.pid === pid)) record.processes.push({ pid, pending: true });
    });
    const rows = await probeProcesses([pid], descendants);
    if (!rows.every(validProcess)) fail("REMOTE_PROCESS_EVIDENCE_UNAVAILABLE");
    const root = rows.find(row => row.pid === pid);
    if (root && (root.parent_pid !== lease.owner.pid || previousProcess &&
        Date.parse(previousProcess.started_at) !== Date.parse(root.started_at))) fail("REMOTE_PROCESS_IDENTITY_CHANGED");
    if (!rows.some(row => row.pid === pid)) rows.push({ pid, observed_absent_at: new Date().toISOString() });
    const evidence = rows.map(row => row.observed_absent_at ? { pid: row.pid, observed_absent_at: row.observed_absent_at } :
      { pid: row.pid, parent_pid: row.parent_pid, started_at: row.started_at });
    await updateLease(lease, (registry, index) => {
      const record = registry.leases[index];
      record.processes = record.processes.filter(row => !(row.pid === pid && row.pending));
      for (const row of evidence) {
        if (!record.processes.some(old => old.pid === row.pid && old.started_at === row.started_at &&
            old.observed_absent_at === row.observed_absent_at)) record.processes.push(row);
      }
    });
    return evidence;
  }

  async function inspect() {
    try {
      const maxLeases = await readMaxLeases();
      const context = await resolveContext();
      return await inspectState(context.store, context.workspace, maxLeases);
    } catch (error) {
      const code = error?.code?.startsWith("REMOTE_") ? error.code : "REMOTE_REGISTRY_UNAVAILABLE";
      return {
        status: "unavailable", code, lease_count: null, max_leases: null,
        unknown_count: null, global_locked: true, scope_bridge: null, admission_locked: null,
        legacy: { active_lock: null, maintenance_lock: null }, leases: []
      };
    }
  }

  return { acquire, release, retain, inspect, noteProcess, recoverySnapshot, recoverSelectedLease };
}
