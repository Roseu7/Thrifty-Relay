import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { SOURCE_BUILD_FILES } from "../src/source-build.mjs";

// A file the server loads but the hash leaves out can change without health reporting
// source=changed-restart-required, so the running server and a newly spawned worker would
// silently run different code. The entries are what the tunnel and the server start.
const root = path.resolve(import.meta.dirname, "..");
const entries = ["index.mjs", "scripts/sanitized-mcp.mjs", "src/codex/worker.mjs", "src/mcp/code-mode-worker.cjs"];
const result = await build({
  absWorkingDir: root, entryPoints: entries, bundle: true, write: false, metafile: true,
  platform: "node", format: "esm", packages: "external", outdir: "unused", logLevel: "silent",
});
const loaded = Object.keys(result.metafile.inputs).map(file => file.replaceAll("\\", "/"));
const missing = loaded.filter(file => !SOURCE_BUILD_FILES.includes(file));
assert.deepEqual(missing, [], "loaded by the server but not in SOURCE_BUILD_FILES");
for (const file of SOURCE_BUILD_FILES) await fs.access(path.join(root, file));
assert.equal(new Set(SOURCE_BUILD_FILES).size, SOURCE_BUILD_FILES.length);

console.log(`PASS: source hash covers all ${loaded.length} loaded modules`);
