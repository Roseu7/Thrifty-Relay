import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { TerminalManager } from "@wonderwhy-er/desktop-commander/dist/terminal-manager.js";

const originalSpawn = childProcess.spawn;
let child;
try {
  childProcess.spawn = () => {
    child = new EventEmitter();
    child.pid = 6123;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  };
  syncBuiltinESMExports();
  for (const code of [0, 7]) {
    const manager = new TerminalManager();
    const pending = manager.executeCommand("fixture", 100, "sh");
    // Node may deliver the final pipe data after 'exit', but always before 'close'.
    child.emit("exit", code);
    child.stdout.emit("data", Buffer.from("LATE_STDOUT\n"));
    child.stderr.emit("data", Buffer.from("LATE_STDERR\n"));
    child.emit("close", code);
    const result = await pending;
    assert.equal(result.output, "LATE_STDOUT\nLATE_STDERR\n");
    const stored = manager.readOutputPaginated(child.pid);
    assert.equal(stored.isComplete, true);
    assert.equal(stored.exitCode, code);
    assert.equal(stored.lines.join("\n"), "LATE_STDOUT\nLATE_STDERR\n");
  }
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
console.log("COMMAND OUTPUT CHECKS OK (stdout/stderr after exit, success and failure)");
