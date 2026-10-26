import { sanitizeMcpEnvironment } from "../src/runtime/env.mjs";

// The tunnel starts this entrypoint with its own environment. Remove the control-plane
// key, the runtime-key escape hatch, and tunnel-only settings before any MCP code runs.
const cleaned = sanitizeMcpEnvironment(process.env);
for (const name of Object.keys(process.env)) {
  if (!Object.hasOwn(cleaned, name)) delete process.env[name];
}

await import("./mcp-entry.mjs");
