import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PowerShellSession, powerShellSessionLimits } from "../scripts/powershell-session.mjs";

export const checks = [];

function trackedSession(options = {}) {
  const children = [];
  let spawnCount = 0;
  const session = new PowerShellSession({
    ...options,
    spawnProcess(executable, args, spawnOptions) {
      spawnCount++;
      const child = options.spawnProcess
        ? options.spawnProcess(executable, args, spawnOptions)
        : spawn(executable, args, spawnOptions);
      children.push(child);
      return child;
    },
  });
  return { session, children, get spawnCount() { return spawnCount; } };
}

async function assertChildrenStopped(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    assert(child.exitCode !== null || child.signalCode !== null, "PowerShell session child must exit before test completion");
  }
}

if (process.platform !== "win32") {
  checks.push("windows-powershell-session-smoke-skipped-off-windows");
} else {
  {
    const tracked = trackedSession();
    const first = tracked.session.run(["Start-Sleep -Milliseconds 60", "'first'"].join("\n"), "MCP_TEST_SESSION_FAILED");
    const second = tracked.session.run("'second'", "MCP_TEST_SESSION_FAILED");
    const scoped = tracked.session.run(["$relaySessionLeak = 'value'", "function Test-RelaySessionLeak {}", "'scope-set'"].join("\n"), "MCP_TEST_SESSION_FAILED");
    const isolation = tracked.session.run(
      ["$variable = Get-Variable relaySessionLeak -ErrorAction SilentlyContinue", "$function = Get-Command Test-RelaySessionLeak -ErrorAction SilentlyContinue", "if ($variable -or $function) { throw 'SCOPE_LEAK' }", "'scope-clean'"].join("\n"),
      "MCP_TEST_SESSION_FAILED");
    assert.deepEqual(await Promise.all([first, second, scoped, isolation]), ["first", "second", "scope-set", "scope-clean"]);
    await tracked.session.close();
    await assertChildrenStopped(tracked.children);
    assert.equal(tracked.spawnCount, 1);
    checks.push("single-process-ordered-requests-and-isolated-script-scope");
  }

  {
    const tracked = trackedSession();
    const source = ["'row 1'", "'こんにちは'", "'quote: ''ok'''"].join("\n");
    assert.equal(await tracked.session.run(source, "MCP_TEST_SESSION_FAILED"), ["row 1", "こんにちは", "quote: 'ok'"].join("\r\n"));
    await tracked.session.close();
    await assertChildrenStopped(tracked.children);
    checks.push("multiline-unicode-and-quote-roundtrip");
  }

  {
    const tracked = trackedSession();
    await assert.rejects(tracked.session.run("throw 'DO_NOT_SURFACE_THIS'", "MCP_TEST_SCRIPT_FAILED"), { code: "MCP_TEST_SCRIPT_FAILED" });
    await tracked.session.close();
    await assertChildrenStopped(tracked.children);
    assert.equal(tracked.spawnCount, 1);
    checks.push("script-errors-propagate-without-error-text-or-leftover-process");
  }

  {
    const tracked = trackedSession({ timeoutMs: 3000 });
    await tracked.session.run("'ready'", "MCP_TEST_HANG_FAILED");
    await assert.rejects(tracked.session.run("while ($true) { Start-Sleep -Milliseconds 50 }", "MCP_TEST_HANG_FAILED"), { code: "MCP_TEST_HANG_FAILED" });
    await tracked.session.close();
    await assertChildrenStopped(tracked.children);
    assert.equal(tracked.spawnCount, 1);
    checks.push("hung-command-timeout-kills-session-and-cleans-process");
  }

  {
    const tracked = trackedSession({ timeoutMs: 60000 });
    await tracked.session.run("'ready'", "MCP_TEST_ABORT_FAILED");
    const active = tracked.session.run("while ($true) { Start-Sleep -Milliseconds 50 }", "MCP_TEST_ABORT_FAILED");
    await new Promise(resolve => setTimeout(resolve, 150));
    await tracked.session.close();
    await assert.rejects(active, { code: "MCP_TEST_ABORT_FAILED" });
    await assertChildrenStopped(tracked.children);
    assert.equal(tracked.spawnCount, 1);
    checks.push("aborted-in-flight-session-kills-process-and-rejects-pending-command");
  }

  {
    const tracked = trackedSession();
    await assert.rejects(tracked.session.run("exit 9", "MCP_TEST_EXIT_FAILED"), { code: "MCP_TEST_EXIT_FAILED" });
    await tracked.session.close();
    await assertChildrenStopped(tracked.children);
    assert.equal(tracked.spawnCount, 1);
    checks.push("unexpected-child-exit-is-reported-and-cleaned");
  }

  {
    const tracked = trackedSession({ timeoutMs: 3000 });
    await assert.rejects(tracked.session.run("'x' * 2097153", "MCP_TEST_OUTPUT_LIMIT"), { code: "MCP_TEST_OUTPUT_LIMIT" });
    await tracked.session.close();
    await assertChildrenStopped(tracked.children);
    assert.equal(tracked.spawnCount, 1);
    checks.push("response-size-limit-fails-closed");
  }
}

{
  let spawned = 0;
  const tracked = trackedSession({ spawnProcess: () => { spawned++; throw new Error("fixture"); } });
  await assert.rejects(tracked.session.run("'not launched'", "MCP_TEST_START_FAILED"), { code: "MCP_TEST_START_FAILED" });
  await tracked.session.close();
  assert.equal(spawned, 1);
  checks.push("spawn-failure-is-reported-without-retry");
}

{
  const tracked = trackedSession();
  const oversized = "x".repeat(powerShellSessionLimits.maxScriptBytes + 1);
  await assert.rejects(tracked.session.run(oversized, "MCP_TEST_INPUT_LIMIT"), { code: "MCP_TEST_INPUT_LIMIT" });
  assert.equal(tracked.spawnCount, 0);
  await tracked.session.close();
  checks.push("request-size-limit-rejects-before-process-launch");
}

if (process.platform === "win32") {
  {
    const ready = JSON.stringify({ id: 0, ready: true });
    const frame = `TR1:0:${Buffer.from(ready, "utf8").toString("base64")}\n`;
    const code = `process.stdout.write(${JSON.stringify(frame)}); process.stdin.on('data', () => { process.stdin.destroy(); process.exit(0); });`;
    const tracked = trackedSession({
      timeoutMs: 3000,
      spawnProcess: (_executable, _args, spawnOptions) => spawn(process.execPath, ["-e", code], spawnOptions),
    });
    await assert.rejects(tracked.session.run("'closed pipe'", "MCP_TEST_PIPE_FAILED"), { code: "MCP_TEST_PIPE_FAILED" });
    await tracked.session.close();
    await assertChildrenStopped(tracked.children);
    assert.equal(tracked.spawnCount, 1);
    checks.push("closed-stdin-pipe-fails-and-cleans-session");
  }
}
