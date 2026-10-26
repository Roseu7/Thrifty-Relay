import { runSecretCommand } from "../posix/secrets.mjs";

// The Secret Service API (libsecret) is the only user scoped secret store that every
// Linux desktop agrees on. Headless servers usually run no session bus at all, so an
// absent backend is an expected outcome rather than a defect: callers report
// CREDENTIAL_BACKEND_UNAVAILABLE and the operator supplies the key through the
// environment override instead.
export const SECRET_TOOL = "secret-tool";
export const SECRET_LABEL = "ThriftyRelay control plane key";

// Attributes identify the stored item. They are values, not arguments to a shell, so
// they are passed one by one without quoting.
const ATTRIBUTES = ["service", "ThriftyRelay", "key", "CONTROL_PLANE_API_KEY"];

function platformError(code) {
  return Object.assign(new Error(code), { code });
}

export function createCredentialStore({ platform = process.platform, env = process.env, run = runSecretCommand } = {}) {
  const hasSessionBus = () =>
    typeof env.DBUS_SESSION_BUS_ADDRESS === "string" && env.DBUS_SESSION_BUS_ADDRESS.length > 0;

  async function invoke(args, input) {
    if (platform !== "linux") throw platformError("CREDENTIAL_BACKEND_UNAVAILABLE");
    try {
      return await run(SECRET_TOOL, args, input);
    } catch (error) {
      if (error?.code === "ENOENT") throw platformError("CREDENTIAL_BACKEND_UNAVAILABLE");
      throw platformError("CREDENTIAL_BACKEND_ERROR");
    }
  }

  // `secret-tool lookup` is the only subcommand whose exit status is reliable: 0 with the
  // value on stdout when the item exists, 1 with no output when it does not. `search`
  // was avoided because its status for "no match" varies between libsecret builds, and a
  // false "registered" would make setup look complete while the runtime has no key.
  async function lookup() {
    const result = await invoke(["lookup", ...ATTRIBUTES]);
    if (result.code === 0) {
      const secret = String(result.stdout ?? "").replace(/\n$/, "");
      if (!secret) throw platformError("CREDENTIAL_BACKEND_ERROR");
      return { state: "registered", secret };
    }
    if (result.code === 1 && !String(result.stderr ?? "").trim()) {
      // secret-tool reports both "item absent" and "no Secret Service reachable"
      // as a silent exit 1. Without a session bus there is nowhere to store the key.
      if (!hasSessionBus()) throw platformError("CREDENTIAL_BACKEND_UNAVAILABLE");
      return { state: "missing" };
    }
    throw platformError("CREDENTIAL_BACKEND_ERROR");
  }

  return {
    async has() {
      // The value travels through a pipe into this process but is dropped here; only the
      // existence answer leaves. There is no cheaper existence check on this backend.
      return (await lookup()).state === "registered";
    },
    async set(secret) {
      if (typeof secret !== "string" || !secret || secret.includes("\0") || Buffer.byteLength(secret, "utf8") > 65535) {
        throw platformError("CREDENTIAL_INPUT_INVALID");
      }
      if (!hasSessionBus()) throw platformError("CREDENTIAL_BACKEND_UNAVAILABLE");
      // The value goes in on stdin so it never reaches the process argument list, which
      // other processes of the same user can read.
      const result = await invoke(["store", `--label=${SECRET_LABEL}`, ...ATTRIBUTES], secret);
      if (result.code !== 0) throw platformError("CREDENTIAL_WRITE_FAILED");
      return true;
    },
    async get() {
      const result = await lookup();
      if (result.state === "missing") return { state: "missing" };
      return { state: "registered", secret: result.secret };
    },
    async delete() {
      if (!hasSessionBus()) throw platformError("CREDENTIAL_BACKEND_UNAVAILABLE");
      const result = await invoke(["clear", ...ATTRIBUTES]);
      if (result.code !== 0 && !(result.code === 1 && !String(result.stderr ?? "").trim())) {
        throw platformError("CREDENTIAL_BACKEND_ERROR");
      }
      // A successful clear only covers items the service can unlock. Check that no matching
      // item is still visible; otherwise a locked item would be reported as removed.
      const remaining = await lookup();
      if (remaining.state === "registered") throw platformError("CREDENTIAL_DELETE_FAILED");
      return result.code === 0;
    },
  };
}
