import path from "node:path";

// Directory conventions are data rather than branches: only these values differ between
// the POSIX systems this project supports.
const CONVENTIONS = {
  linux: {
    configDirectory: (env, home) => env.XDG_CONFIG_HOME || path.posix.join(home, ".config"),
    // XDG_STATE_HOME is only honoured when absolute; a relative value is not a location
    // the specification permits us to guess at.
    stateDirectory: (env, home) => {
      const base = typeof env.XDG_STATE_HOME === "string" && path.posix.isAbsolute(env.XDG_STATE_HOME)
        ? env.XDG_STATE_HOME : path.posix.join(home, ".local", "state");
      return path.posix.join(base, "thriftyrelay");
    },
    caseInsensitive: false,
  },
  darwin: {
    // macOS puts user application data under ~/Library, not ~/.config.
    configDirectory: (_env, home) => path.posix.join(home, "Library", "Application Support"),
    stateDirectory: (_env, home) => path.posix.join(home, "Library", "Application Support", "ThriftyRelay"),
    // APFS and HFS+ fold case by default. A case-sensitive APFS volume exists but is
    // rare; the per-volume probe is tracked separately because detecting it needs the
    // mount root (a probe on "/" misreads /mnt/c under WSL).
    caseInsensitive: true,
  },
};

function platformError(code) {
  return Object.assign(new Error(code), { code });
}

// Only path.posix is used, so a POSIX adapter behaves the same when a test simulates
// this platform from a different host.
export function createPosixPaths(platform) {
  const conventions = CONVENTIONS[platform];
  // An unknown POSIX system must fail loudly; guessing ~/.config would silently write
  // the configuration somewhere the user does not expect.
  if (!conventions) throw platformError("REMOTE_PLATFORM_UNSUPPORTED");

  function caseFold(value) {
    const text = String(value);
    return conventions.caseInsensitive ? text.toLowerCase() : text;
  }
  function canonical(value) {
    return caseFold(path.posix.resolve(String(value)));
  }

  return {
    caseFold,
    comparisonKey: canonical,
    samePath: (left, right) => canonical(left) === canonical(right),
    isAbsolute: value => typeof value === "string" && path.posix.isAbsolute(value),
    normalize: value => path.posix.normalize(String(value)),
    configFile({ env, home }) {
      return path.posix.join(conventions.configDirectory(env, home), "ThriftyRelay", "config.json");
    },
    taskDirectory({ env, home }) {
      return env.THRIFTYRELAY_TASK_DIR || path.posix.join(conventions.stateDirectory(env, home), "tasks");
    },
    // A cache location is the platform convention for disposable data. The root is still
    // task-scoped; the OS may reclaim it, and cleanup treats retention as best effort.
    tempDirectory({ env, home }) {
      if (typeof env.THRIFTYRELAY_TEMP_DIR === "string" && path.posix.isAbsolute(env.THRIFTYRELAY_TEMP_DIR)) return env.THRIFTYRELAY_TEMP_DIR;
      const base = platform === "darwin"
        ? path.posix.join(home, "Library", "Caches")
        : typeof env.XDG_CACHE_HOME === "string" && path.posix.isAbsolute(env.XDG_CACHE_HOME)
          ? env.XDG_CACHE_HOME
          : path.posix.join(home, ".cache");
      return path.posix.join(base, platform === "darwin" ? "ThriftyRelay" : "thriftyrelay", "temp");
    },
    runtimeDirectory({ env, home }) {
      return conventions.stateDirectory(env, home);
    },
    executableLookup(name) {
      return { command: "which", args: [name] };
    },
  };
}
