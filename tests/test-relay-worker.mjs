import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
process.once("message", async ({ cwd, thread_id, prompt, model, reasoning_effort }) => {
  await fs.writeFile(path.join(cwd, "..", "selection.json"), JSON.stringify({ model, reasoning_effort }));
  process.send({ type: "thread", id: thread_id || "12345678-1234-1234-1234-123456789abc" });
  const commands = [];
  if (prompt === "edit") {
    await fs.writeFile(path.join(cwd, "sum.mjs"), "export const sum = (a,b) => a+b;\n");
    await fs.writeFile(path.join(cwd, "surprise.txt"), "unexpected fixture change\n");
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
      "import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum(2,3),5); console.log('ASSERT_OK');"], { cwd, windowsHide: true });
    commands.push({ command: "node assertion sum(2,3) === 5", status: "completed", exit_code: 0, output: stdout.trim() });
  }
  if (prompt.startsWith("handoff:")) {
    if (!prompt.includes("surprise.txt") || !prompt.includes("unexpected")) process.exit(7);
    await fs.unlink(path.join(cwd, "surprise.txt"));
  }
  if (prompt === "unavailable") {
    process.send({ type: "result", completed: false, error_code: "CODEX_MODEL_UNAVAILABLE" }, () => process.exit(1)); return;
  }
  process.send({ type: "result", completed: true, answer: "FIXTURE_OK", commands, commands_omitted: 0 }, () => process.exit(0));
});
