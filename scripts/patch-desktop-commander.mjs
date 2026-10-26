import fs from "node:fs/promises";

// Desktop Commander #395: 'exit' can precede the final stdout/stderr data events.
// Keep this patch tied to the pinned release; dependency updates need a fresh review.
const directory = new URL("../node_modules/@wonderwhy-er/desktop-commander/", import.meta.url);
const metadata = JSON.parse(await fs.readFile(new URL("package.json", directory), "utf8"));
if (metadata.version !== "0.2.52") throw new Error("DESKTOP_COMMANDER_PATCH_VERSION_MISMATCH");
const file = new URL("dist/terminal-manager.js", directory);
const source = await fs.readFile(file, "utf8");
const before = "childProcess.on('exit', (code) => {";
const after = "childProcess.on('close', (code) => {";
const count = text => source.split(text).length - 1;
if (count(before) === 1 && count(after) === 0) {
  await fs.writeFile(file, source.replace(before, after));
} else if (count(before) !== 0 || count(after) !== 1) {
  throw new Error("DESKTOP_COMMANDER_PATCH_SOURCE_MISMATCH");
}
