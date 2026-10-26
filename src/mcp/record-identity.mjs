import fs from "node:fs/promises";
import path from "node:path";
import { samePath } from "../platform/index.mjs";

// Records are protected from substitution: the file must be the one the caller named
// rather than a symbolic link pointing somewhere else. Only the record itself has to be
// link free. A parent directory may legitimately be a link, and rejecting that would
// reject every record kept under one: macOS reports the system temporary directory as
// /var/... while its realpath is /private/var/..., so a plain comparison of the raw path
// against its realpath fails on a directory that is not a link at all.
//
// Comparing the realpath of the parent plus the record's own name keeps the protection
// while tolerating a linked parent: a linked record still resolves outside its parent.
export async function resolvesWithoutLink(file) {
  const [actual, parent] = await Promise.all([fs.realpath(file), fs.realpath(path.dirname(file))]);
  return samePath(path.join(parent, path.basename(file)), actual);
}
