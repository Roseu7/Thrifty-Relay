import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateFile = path.join(root, "ui", "settings.html");
const outputFile = path.join(root, "src", "mcp", "settings-app.html");
const placeholder = '<script id="settings-app-bundle"></script>';
const template = await fs.readFile(templateFile, "utf8");
if (template.split(placeholder).length !== 2) throw new Error("SETTINGS_UI_TEMPLATE_INVALID");

const result = await build({
  entryPoints: [path.join(root, "ui", "settings.mjs")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  write: false,
});
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await fs.writeFile(outputFile, template.replace(placeholder, `<script>${script}</script>`), "utf8");
console.log(`Built ${path.relative(root, outputFile)}`);
