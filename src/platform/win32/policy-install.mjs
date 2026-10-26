import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The registration is only worth what its access control list is worth, so the list is built
// from well known SIDs instead of localised names: "Administrators" is spelled differently on
// every language of Windows, and a grant that silently matched nothing would leave the policy
// writable by the account the MCP runs as.
const OWNER = "*S-1-5-32-544";
const DIRECTORY_GRANTS = ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-32-545:(OI)(CI)RX"];
const FILE_GRANTS = ["*S-1-5-18:F", "*S-1-5-32-544:F", "*S-1-5-32-545:R"];

function installError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

async function icacls(target, arguments_, code = "POLICY_INSTALL_ACL_FAILED") {
  try {
    await execFileAsync("icacls", [target, ...arguments_], { windowsHide: true, timeout: 30_000 });
  } catch {
    // A directory whose list could not be changed must not be reported as registered, even
    // though the file itself may already be in place.
    throw installError(code, target);
  }
}

// A junction or a symbolic link where the registration belongs would redirect the elevated
// write to a location the administrator never saw in the preview.
async function assertNotLinked(target) {
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink()) throw installError("POLICY_INSTALL_PATH_UNSAFE", target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

// An owner may rewrite the access control list at any time, so a registration owned by the
// account that runs the MCP is not protected whatever the list says today. Taking ownership
// is also what makes this an elevated operation: without the restore privilege it fails, and
// nothing has been written yet.
async function takeOwnership(target) {
  await icacls(target, ["/setowner", OWNER], "POLICY_INSTALL_PRIVILEGE_REQUIRED");
}

// A reset first, so entries inherited from ProgramData and any explicit entry left behind by
// whoever created the directory are gone before the final list is applied. Replacing entries
// with /grant:r alone would keep an extra grant someone had added.
async function lockDown(target, grants) {
  await icacls(target, ["/reset"]);
  await icacls(target, ["/inheritance:r", "/grant:r", ...grants]);
}

export async function installPolicy({ file, content }) {
  const directory = path.dirname(file);
  await assertNotLinked(directory);
  await assertNotLinked(file);

  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  await takeOwnership(directory);
  // The directory is locked before the file is written, so the new policy inherits a list
  // that already excludes writes.
  await lockDown(directory, DIRECTORY_GRANTS);

  const temporary = file + ".new";
  await fs.rm(temporary, { force: true });
  try {
    await fs.writeFile(temporary, content, { mode: 0o644 });
    await takeOwnership(temporary);
    await lockDown(temporary, FILE_GRANTS);
    // A replace, not an edit: a reader sees the previous registration or the new one.
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  // The moved file kept the list it had; applying it again under the final name keeps the
  // promise true even if a rename implementation ever carried less than expected.
  await takeOwnership(file);
  await lockDown(file, FILE_GRANTS);
  return { file, directory };
}
