import fs from "node:fs/promises";
import path from "node:path";

function installError(code, detail) {
  const error = Object.assign(new Error(code), { code });
  if (detail !== undefined) error.detail = detail;
  return error;
}

// The registration is only meaningful when the account that runs the MCP cannot produce it,
// so a POSIX install without root refuses rather than writing a file the MCP could replace.
async function assertRoot() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw installError("POLICY_INSTALL_PRIVILEGE_REQUIRED");
  }
}

async function assertNotLinked(target) {
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink()) throw installError("POLICY_INSTALL_PATH_UNSAFE", target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

export async function installPolicy({ file, content }) {
  await assertRoot();

  const directory = path.dirname(file);
  await assertNotLinked(directory);
  await assertNotLinked(file);

  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = file + ".new";
  await fs.rm(temporary, { force: true });
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.chown(temporary, 0, 0);
    await fs.chmod(temporary, 0o444);
    // A replace, not an edit: a reader sees the previous registration or the new one.
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }

  await fs.chown(file, 0, 0);
  await fs.chmod(file, 0o444);
  // The directory closes last: while it accepts new entries the file can still be replaced,
  // so no moment after the final state is weaker than the registration promises. The read
  // side checks exactly these two things (design 2.6.1).
  await fs.chown(directory, 0, 0);
  await fs.chmod(directory, 0o555);
  return { file, directory };
}
