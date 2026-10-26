// The tunnel needs the control-plane key, but nothing it spawns does. These lists are
// shared by the supervisor and the MCP bootstrap so the two boundaries cannot drift.
const TUNNEL_SECRET_NAME = /^(?:CONTROL_PLANE|OPENAI|TUNNEL_CLIENT|CLOUDFLARED)_(?:[A-Z0-9]+_)*(?:API_KEY|ADMIN_KEY|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|SECRET|CREDENTIAL|PASSWORD)(?:_[A-Z0-9]+)*$/i;

const TUNNEL_SECRET_ENV = [
  "CONTROL_PLANE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "CONTROL_PLANE_ADMIN_API_KEY",
];

const TUNNEL_CONFIG_ENV = [
  ...TUNNEL_SECRET_ENV,
  "CONTROL_PLANE_TUNNEL_ID",
  "CONTROL_PLANE_BASE_URL",
  "CONTROL_PLANE_URL_PATH",
  "TUNNEL_CLIENT_PROFILE_DIR",
  "MCP_COMMAND",
  "MCP_SERVER_URL",
  "LOG_HTTP_RAW_UNSAFE",
];

const TUNNEL_ONLY_NAMES = new Set(TUNNEL_CONFIG_ENV);

// This is an input to the runtime, not to the tunnel. The tunnel authenticates with
// CONTROL_PLANE_API_KEY, so the source variable is removed from both child boundaries.
export const RUNTIME_KEY_ENVIRONMENT_VARIABLE = "THRIFTYRELAY_RUNTIME_KEY";

function isRuntimeKeyName(name) {
  return String(name).toUpperCase() === RUNTIME_KEY_ENVIRONMENT_VARIABLE;
}

// The tunnel inherits the useful parts of the caller's environment (workspace, PATH,
// proxies) but never another secret or a stale tunnel setting.
export function tunnelEnvironment(source, runtimeKey) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (isRuntimeKeyName(name) || TUNNEL_CONFIG_ENV.includes(name.toUpperCase()) || TUNNEL_SECRET_NAME.test(name)) {
      delete env[name];
    }
  }
  env.CONTROL_PLANE_API_KEY = runtimeKey;
  return env;
}

// The MCP is reached through the tunnel and has no reason to see either key name. The
// removed set is the same tunnel boundary plus the runtime-key escape hatch.
export function sanitizeMcpEnvironment(source) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (isRuntimeKeyName(name) || TUNNEL_SECRET_NAME.test(name) || TUNNEL_ONLY_NAMES.has(name.toUpperCase())) {
      delete env[name];
    }
  }
  return env;
}
