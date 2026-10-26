import { runSecretCommand } from "../posix/secrets.mjs";

// The login keychain is present on every macOS install, so this backend needs no
// additional dependency. It is reached through /usr/bin/security rather than the
// Keychain API because a native binding would add a compiled dependency to the package.
export const SECURITY_TOOL = "/usr/bin/security";
export const KEYCHAIN_SERVICE = "ThriftyRelay/CONTROL_PLANE_API_KEY";
export const KEYCHAIN_ACCOUNT = "ThriftyRelay";

// errSecItemNotFound (-25300) is what `security` reports for a missing item; the process
// exit status is the low byte of that code, so 44 is the stable value to match.
const EXIT_ITEM_NOT_FOUND = 44;

function platformError(code) {
  return Object.assign(new Error(code), { code });
}

export function createCredentialStore({
  platform = process.platform,
  run = runSecretCommand,
  // The item identity is data rather than a fixed constant so a test can use its own
  // keychain item and never touch the one the product uses.
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
} = {}) {
  async function invoke(args) {
    if (platform !== "darwin") throw platformError("CREDENTIAL_BACKEND_UNAVAILABLE");
    try {
      return await run(SECURITY_TOOL, args);
    } catch (error) {
      if (error?.code === "ENOENT") throw platformError("CREDENTIAL_BACKEND_UNAVAILABLE");
      throw platformError("CREDENTIAL_BACKEND_ERROR");
    }
  }

  function missingItem(result) {
    // Match the item-specific message, not a missing keychain or a generic lookup failure.
    return result.code === EXIT_ITEM_NOT_FOUND ||
      /specified item could not be found/i.test(String(result.stderr ?? ""));
  }

  return {
    async has() {
      // Without -w this prints item attributes only, so the check never reads the value.
      const result = await invoke(["find-generic-password", "-s", service, "-a", account]);
      if (result.code === 0) return true;
      if (missingItem(result)) return false;
      throw platformError("CREDENTIAL_BACKEND_ERROR");
    },
    async set(secret) {
      if (typeof secret !== "string" || !secret || secret.includes("\0") || Buffer.byteLength(secret, "utf8") > 65535) {
        throw platformError("CREDENTIAL_INPUT_INVALID");
      }
      // `security -w` reports a value holding control characters or 8-bit bytes in a hex
      // form, so such a value would be read back as a different secret. A runtime key is
      // a token, and storing something the reader would misreport is worse than refusing.
      if (!/^[\x20-\x7e]+$/.test(secret)) throw platformError("CREDENTIAL_INPUT_INVALID");
      // The item is created without -A, so its access control list keeps the default
      // restriction instead of granting every application read access.
      // Known limitation: `security` has no way to take the secret from stdin, and its
      // interactive mode splits a command line on whitespace, which a key may contain.
      // The value is therefore passed as an argument and is visible to other processes
      // of the same user for the duration of this one write.
      const result = await invoke(["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret]);
      if (result.code !== 0) throw platformError("CREDENTIAL_WRITE_FAILED");
      return true;
    },
    async get() {
      const result = await invoke(["find-generic-password", "-w", "-s", service, "-a", account]);
      if (result.code === 0) {
        const secret = String(result.stdout ?? "").replace(/\n$/, "");
        if (!secret) throw platformError("CREDENTIAL_BACKEND_ERROR");
        return { state: "registered", secret };
      }
      if (missingItem(result)) return { state: "missing" };
      throw platformError("CREDENTIAL_BACKEND_ERROR");
    },
    async delete() {
      const result = await invoke(["delete-generic-password", "-s", service, "-a", account]);
      if (result.code === 0) return true;
      if (missingItem(result)) return false;
      throw platformError("CREDENTIAL_BACKEND_ERROR");
    },
  };
}
