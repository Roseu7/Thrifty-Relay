import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

process.once("message", async ({ cwd, thread_id, prompt }) => {
  const records = path.join(cwd, "..", "tasks", "codex", "requests");
  const claims = await Promise.all((await fs.readdir(records)).map(async name => JSON.parse(await fs.readFile(path.join(records, name), "utf8"))));
  if (!claims.some(item => item.state === "running")) process.exit(9);
  await fs.appendFile(path.join(cwd, "invocations.txt"), "run\n");
  await fs.writeFile(path.join(cwd, "child-env.json"), JSON.stringify({
    api_key: !!process.env.OPENAI_API_KEY, codex_api_key: !!process.env.CODEX_API_KEY,
    azure_key: !!process.env.AZURE_OPENAI_API_KEY, endpoint: !!process.env.OPENAI_BASE_URL,
  }));
  process.send({ type: "thread", id: thread_id || "12345678-1234-1234-1234-123456789abc" });
  if (prompt === "crash") process.exit(7);
  if (prompt === "diagnostic-fail") {
    process.send({ type: "progress", phase: "event_stream" });
    process.send({ type: "result", completed: false, error_code: "CODEX_TURN_FAILED", diagnostic: {
      origin: "sdk_event", phase: "turn_failed", category: "network", thread_started: true,
      events_seen: 3, stderr: "Bearer fixture-secret-token", message: "sk-test-key-not-for-network"
    } }, () => process.exit(1));
    return;
  }
  if (prompt === "diagnostic-exit") process.exit(21);
  if (prompt === "hang") {
    const child = spawn(process.execPath, ["-e",
      "setInterval(()=>require('fs').appendFileSync(process.argv[1],'.'),40)", path.join(cwd, "ticks.txt")],
      { stdio: "ignore", windowsHide: true });
    await fs.writeFile(path.join(cwd, "grandchild.pid"), String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt === "slow") await new Promise(resolve => setTimeout(resolve, 1000));
  process.send({ type: "result", completed: true,
    answer: prompt === "long" ? '\n"\\'.repeat(2600) + " Bearer abcdefghijklmnop" : "FIXTURE_OK" }, () => process.exit(0));
});
