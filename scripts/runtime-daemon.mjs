#!/usr/bin/env node
import path from "node:path";
import { runBackgroundSupervisor } from "../src/runtime/supervisor.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const instanceId = option("--instance-id");
const stateFile = option("--state-file");
const configFile = option("--config-file");

if (!instanceId || !stateFile || !configFile) {
  process.exitCode = 2;
} else {
  process.exitCode = await runBackgroundSupervisor({
    instanceId,
    stateFile: path.resolve(stateFile),
    configFile: path.resolve(configFile),
  });
}
