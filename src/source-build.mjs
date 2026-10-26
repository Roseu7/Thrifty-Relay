import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Every file the running server or its workers load: their import graph, which
// tests/test-source-build.mjs checks against this list, plus the data files read at runtime.
// recovery.mjs is not imported by the server, but the recovery tool and the server must agree
// on the lock records, so a change to it also waits for a restart. Documents are left out:
// ChatGPT reads docs/en/orchestration.md from disk each time, so an edited document is already
// current and hashing it would block writers until a restart that changes nothing.
export const SOURCE_BUILD_FILES = Object.freeze([
  "index.mjs",
  "scripts/sanitized-mcp.mjs",
  "scripts/mcp-entry.mjs",
  "src/server.mjs",
  "src/source-build.mjs",
  "src/config.mjs",
  "src/version.mjs",
  "src/cli/settings.mjs",
  "src/i18n/index.mjs",
  "src/runtime/env.mjs",
  "src/mcp/task-manager.mjs",
  "src/mcp/image-content.mjs",
  "src/mcp/task-storage.mjs",
  "src/mcp/scratch.mjs",
  "src/mcp/execution-guard.mjs",
  "src/mcp/scope-leases.mjs",
  "src/mcp/record-identity.mjs",
  "src/mcp/approval.mjs",
  "src/mcp/approval-pending.mjs",
  "src/mcp/admission.mjs",
  "src/mcp/access.mjs",
  "src/mcp/patch.mjs",
  "src/mcp/code-mode.mjs",
  "src/mcp/code-mode-worker.cjs",
  "src/mcp/recovery.mjs",
  "src/codex/adapter.mjs",
  "src/codex/worker.mjs",
  "src/codex/diagnostics.mjs",
  "src/codex/usage-limits.mjs",
  "src/codex/quota-gate.mjs",
  "src/codex/review-evidence.mjs",
  "src/skills/catalog.mjs",
  "src/platform/index.mjs",
  "src/platform/policy.mjs",
  "src/platform/posix/paths.mjs",
  "src/platform/posix/process.mjs",
  "src/platform/posix/secrets.mjs",
  "src/platform/posix/policy-install.mjs",
  "src/platform/linux/secrets.mjs",
  "src/platform/darwin/secrets.mjs",
  "src/platform/win32/paths.mjs",
  "src/platform/win32/powershell.mjs",
  "src/platform/win32/process.mjs",
  "src/platform/win32/secrets.mjs",
  "src/platform/win32/service.mjs",
  "src/platform/win32/task.mjs",
  "src/platform/win32/launcher.mjs",
  "src/platform/win32/policy-install.mjs",
  "src/mcp/settings-app.html",
  "src/mcp/approval-app.html",
  "ui/settings.mjs",
  "locales/en.json",
  "locales/ja.json",
  "assets/tr.svg",
  "assets/tr.png",
  "package.json",
]);

export async function sourceBuild(appDirectory) {
  const hash = createHash("sha256");
  for (const name of SOURCE_BUILD_FILES) {
    hash.update(name); hash.update(await fs.readFile(path.join(appDirectory, name)));
  }
  return hash.digest("hex").slice(0, 12);
}
