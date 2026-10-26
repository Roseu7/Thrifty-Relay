import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testArea } from "./test-artifacts.mjs";
import { probeProcesses } from "../src/mcp/execution-guard.mjs";

const suites = { standard: "test.mjs", async: "test-async.mjs", code: "test-code.mjs",
  codex: "test-codex.mjs", stability: "test-stabilization.mjs", relay: "test-thriftyrelay.mjs",
  "local-ops": "test-local-ops.mjs", cli: "test-cli.mjs", live: "test-relay-live.mjs",
  platform: "test-platform.mjs", access: "test-access.mjs", approval: "test-approval.mjs",
  "approval-pending": "test-approval-pending.mjs",
  "approval-gate": "test-approval-gate.mjs",
  "approval-decline": "test-approval-decline.mjs",
  "policy-install": "test-policy-install.mjs", admission: "test-admission.mjs", scratch: "test-scratch.mjs" };
try {
  const suite = process.argv[2];
  if (!suites[suite] && suite !== "sweep") throw new Error("TEST_UNKNOWN_SUITE");
  const area = await testArea();
  if (suite === "sweep") console.log(JSON.stringify(await area.sweep()));
  else {
    const run = await area.begin(suite);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thriftyrelay-suite-temp-"));
    const env = { ...process.env, THRIFTYRELAY_TEST_ROOT: run.root,
      // POSIX os.tmpdir() reads TMPDIR, so TEMP/TMP alone leak the real /tmp.
      THRIFTYRELAY_TEST_EVIDENCE: path.join(run.runDir, "suite-evidence.json"), TEMP: run.root, TMP: run.root,
      TMPDIR: run.root };
    // A test never inherits the running wrapper's store or validation target.
    delete env.THRIFTYRELAY_TASK_DIR; delete env.THRIFTYRELAY_CODEX_WORKSPACE;
    delete env.THRIFTYRELAY_TEMP_WORKSPACE;
    env.THRIFTYRELAY_TEMP_DIR = tempRoot;
    const child = spawn(process.execPath, [path.join(import.meta.dirname, suites[suite])],
      { cwd: path.resolve(import.meta.dirname, ".."), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
      process.stdout.write(data); log = (log + data.toString()).slice(-16384);
    });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    // The processes a suite spawns (its MCP server and the shells under it) can still be
    // exiting when the suite's own process closes, so a single probe would report a
    // healthy run as a leak on a slow machine. The grace period is bounded and a real
    // leak still fails; the surviving rows are recorded so the next run shows what was
    // left behind instead of just "not stopped".
    let stopped = false;
    let survivors = [];
    let probeFailure = null;
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        survivors = await probeProcesses([child.pid], true);
        stopped = survivors.length === 0;
        probeFailure = null;
      } catch (error) {
        // A failed probe is not evidence that the processes are gone, so the run is
        // reported as not stopped and the reason is recorded: a silent "not stopped"
        // would look like a leftover process and send the reader after the wrong cause.
        stopped = false;
        probeFailure = error?.code || error?.message || "UNKNOWN";
        if (error?.detail) probeFailure += " " + error.detail;
      }
      if ((stopped && !probeFailure) || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!stopped) console.log("PROCESS CHECK " + JSON.stringify({ survivors, probe: probeFailure }));
    const result = await run.finish({ success: code === 0, processes_stopped: stopped, evidence: log });
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    console.log("ARTIFACTS " + JSON.stringify(result));
    process.exitCode = code === 0 && stopped && !result.capacity_exceeded ? 0 : 1;
  }
} catch (error) { console.error(/^TEST_[A-Z_]+$/.test(error.message || "") ? error.message : "TEST_RUNNER_FAILED: " + (error.code || "UNKNOWN") + "\n" + (error.stack || "")); process.exitCode = 1; }
