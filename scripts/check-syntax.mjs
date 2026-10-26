import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateLocaleCatalogs } from "../src/i18n/index.mjs";
const root = path.resolve(import.meta.dirname, "..");
const skipped = new Set([".git", ".test-artifacts", "node_modules", "docs"]);
let count = 0;
async function check(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith(".") || skipped.has(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await check(file);
    else if (item.isFile() && /\.(mjs|cjs)$/.test(item.name)) {
      execFileSync(process.execPath, ["--check", file], { windowsHide: true, stdio: "inherit" });
      count++;
    }
  }
}
await check(root);
const localeResult = validateLocaleCatalogs();
console.log("SYNTAX OK (" + count + " files); LOCALE PARITY OK (" + localeResult.keys + " keys)");
