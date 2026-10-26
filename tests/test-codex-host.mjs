import { randomUUID } from "node:crypto";
import path from "node:path";
import { createCodexAdapter } from "../src/codex/adapter.mjs";
import { createTaskManager } from "../src/mcp/task-manager.mjs";
import { fixtureQuotaReader } from "./quota-fixture.mjs";

process.once("message", async ({ dir, args }) => {
  const text = result => result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
  const taskId = () => `task_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const adapter = createCodexAdapter({ dir, taskId, workerFile: new URL("./test-codex-worker.mjs", import.meta.url),
    quotaReader: fixtureQuotaReader, configFile: path.join(dir, "fixture-config.json") });
  const manager = createTaskManager({ dir, taskId, idPattern: /^task_[a-z0-9]+_[a-z0-9]{6}$/,
    textOf: text, compactText: String, truncate: (s, n) => s.slice(0, n), redactHistory: String,
    executeStep: (step, context) => adapter.execute(step, context) });
  process.send(await adapter.submit(args, manager.run));
});
