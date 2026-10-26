import assert from "node:assert/strict";
import path from "node:path";
import { pathsAdapter, platformName } from "../src/platform/index.mjs";
import { getConfigPath } from "../src/i18n/index.mjs";

const checks = [];
const win32 = pathsAdapter("win32");
const linux = pathsAdapter("linux");
const darwin = pathsAdapter("darwin");

// isAbsolute must answer for the simulated platform, not the host: the same string is
// absolute on Windows and relative on POSIX.
assert.equal(win32.isAbsolute("C:\\workspace"), true);
assert.equal(win32.isAbsolute("workspace\\src"), false);
assert.equal(linux.isAbsolute("/workspace"), true);
assert.equal(linux.isAbsolute("C:\\workspace"), false);
assert.equal(darwin.isAbsolute("/Users/rose"), true);
checks.push("absolute-per-platform");

// Windows volumes fold case and treat both separators as equivalent. A \\?\ prefix is
// not part of the file's identity and must not defeat a comparison.
assert.equal(win32.samePath("C:\\Work\\App.JS", "c:/work/app.js"), true);
assert.equal(win32.samePath("\\\\?\\C:\\Work\\App.js", "c:\\work\\app.js"), true);
assert.equal(win32.samePath("\\\\?\\UNC\\server\\share\\x", "\\\\server\\share\\x"), true);
assert.equal(win32.samePath("C:\\work\\a.js", "C:\\work\\b.js"), false);
checks.push("windows-path-identity");

// POSIX paths resolve against the same rules but stay case-sensitive, so two files that
// differ only by case must not be reported as the same file.
assert.equal(linux.samePath("/work/app.js", "/work/./app.js"), true);
assert.equal(linux.samePath("/work/App.js", "/work/app.js"), false);
assert.equal(linux.comparisonKey("/work/App.js"), "/work/App.js");
checks.push("posix-path-identity");

// macOS default volumes fold case, so the comparison follows the volume, not the name.
assert.equal(darwin.samePath("/Users/Rose/Library", "/users/rose/library"), true);
checks.push("macos-volume-case");

// Configuration lives where each system expects user settings.
assert.equal(win32.configFile({ env: { APPDATA: "C:\\Users\\fixture\\Roaming" }, home: "C:\\Users\\fixture" }),
  path.win32.join("C:\\Users\\fixture\\Roaming", "ThriftyRelay", "config.json"));
assert.equal(win32.configFile({ env: {}, home: "C:\\Users\\fixture" }),
  path.win32.join("C:\\Users\\fixture\\AppData\\Roaming", "ThriftyRelay", "config.json"));
assert.equal(linux.configFile({ env: { XDG_CONFIG_HOME: "/home/rose/.config-custom" }, home: "/home/rose" }),
  "/home/rose/.config-custom/ThriftyRelay/config.json");
assert.equal(linux.configFile({ env: {}, home: "/home/rose" }),
  "/home/rose/.config/ThriftyRelay/config.json");
assert.equal(darwin.configFile({ env: {}, home: "/Users/rose" }),
  "/Users/rose/Library/Application Support/ThriftyRelay/config.json");
checks.push("config-directory-conventions");

// The explicit override outranks every convention and is a real path on this machine, so
// it resolves with host semantics even when another platform is being simulated.
assert.equal(getConfigPath({ env: { THRIFTYRELAY_CONFIG_PATH: "/tmp/c.json" }, platform: "win32", home: "C:\\h" }),
  path.resolve("/tmp/c.json"));
assert.equal(getConfigPath({ env: { THRIFTYRELAY_CONFIG_PATH: "C:\\custom\\c.json" }, platform: "linux", home: "/h" }),
  path.resolve("C:\\custom\\c.json"));
checks.push("config-path-override");

assert.equal(win32.taskDirectory({ env: {}, home: "C:\\Users\\fixture" }),
  path.win32.join("C:\\Users\\fixture", "AppData", "Local", "ThriftyRelay", "tasks"));
assert.equal(linux.taskDirectory({ env: {}, home: "/home/rose" }), "/home/rose/.local/state/thriftyrelay/tasks");
assert.equal(linux.taskDirectory({ env: { THRIFTYRELAY_TASK_DIR: "/srv/tasks" }, home: "/home/rose" }), "/srv/tasks");
assert.equal(linux.runtimeDirectory({ env: {}, home: "/home/rose" }), "/home/rose/.local/state/thriftyrelay");
assert.equal(linux.runtimeDirectory({ env: { XDG_STATE_HOME: "/state" }, home: "/home/rose" }), "/state/thriftyrelay");
assert.equal(linux.runtimeDirectory({ env: { XDG_STATE_HOME: "relative" }, home: "/home/rose" }),
  "/home/rose/.local/state/thriftyrelay");
assert.equal(darwin.runtimeDirectory({ env: {}, home: "/Users/rose" }),
  "/Users/rose/Library/Application Support/ThriftyRelay");
checks.push("task-directory", "runtime-directory");

// The temporary work area is a per-user cache location, never the checkout or the task
// store. An explicit override exists for tests and unusual installs, like the task store's.
assert.equal(win32.tempDirectory({ env: { LOCALAPPDATA: "C:\\Users\\fixture\\Local" }, home: "C:\\Users\\fixture" }),
  path.win32.join("C:\\Users\\fixture\\Local", "ThriftyRelay", "temp"));
assert.equal(linux.tempDirectory({ env: {}, home: "/home/rose" }), "/home/rose/.cache/thriftyrelay/temp");
assert.equal(linux.tempDirectory({ env: { XDG_CACHE_HOME: "/cache" }, home: "/home/rose" }), "/cache/thriftyrelay/temp");
assert.equal(linux.tempDirectory({ env: { XDG_CACHE_HOME: "relative" }, home: "/home/rose" }),
  "/home/rose/.cache/thriftyrelay/temp");
assert.equal(darwin.tempDirectory({ env: {}, home: "/Users/rose" }), "/Users/rose/Library/Caches/ThriftyRelay/temp");
assert.equal(linux.tempDirectory({ env: { THRIFTYRELAY_TEMP_DIR: "/srv/temp" }, home: "/home/rose" }), "/srv/temp");
assert.equal(linux.tempDirectory({ env: { THRIFTYRELAY_TEMP_DIR: "relative" }, home: "/home/rose" }), "/home/rose/.cache/thriftyrelay/temp");
assert.equal(win32.tempDirectory({ env: { LOCALAPPDATA: "C:\\Users\\fixture\\Local", THRIFTYRELAY_TEMP_DIR: "relative" }, home: "C:\\Users\\fixture" }),
  path.win32.join("C:\\Users\\fixture\\Local", "ThriftyRelay", "temp"));
assert.equal(win32.tempDirectory({ env: { LOCALAPPDATA: "relative" }, home: "C:\\Users\\fixture" }),
  path.win32.join("C:\\Users\\fixture", "AppData", "Local", "ThriftyRelay", "temp"));
checks.push("temporary-directory");

// Looking up an executable on PATH is platform-specific: Windows uses where.exe and needs
// the .exe suffix; POSIX uses which and the bare name.
assert.deepEqual(win32.executableLookup("tunnel-client"), { command: "where.exe", args: ["tunnel-client.exe"] });
assert.deepEqual(linux.executableLookup("tunnel-client"), { command: "which", args: ["tunnel-client"] });
checks.push("executable-lookup");

assert.equal(win32.normalize("C:\\work\\sub\\..\\app.js"), "C:\\work\\app.js");
assert.equal(linux.normalize("/work/sub/../app.js"), "/work/app.js");
checks.push("normalize");

assert.throws(() => pathsAdapter("aix"), { code: "REMOTE_PLATFORM_UNSUPPORTED" },
  "an OS without an adapter must fail instead of guessing where configuration lives");
assert.equal(pathsAdapter(process.platform), pathsAdapter(process.platform), "the adapter is cached per platform");
checks.push("unsupported-platform-fails-loudly");

// Health names the system for a person. A simulated or unsupported platform must not be
// reported as Windows.
assert.equal(platformName("win32"), "Windows");
assert.equal(platformName("linux"), "Linux");
assert.equal(platformName("darwin"), "macOS");
assert.equal(platformName("aix"), "aix");
checks.push("platform-label");

console.log("PASS: " + checks.join(", "));
