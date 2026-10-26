import assert from "node:assert/strict";
import { serviceAdapter } from "../src/platform/index.mjs";

// What starts the MCP is registered differently on every system, so the core asks this
// adapter instead of branching on the OS name. The assertions pin the two properties a
// caller depends on: a query is built only from names that were validated and escaped, and
// a definition either matches the expected shape or the read fails outright.

const checks = [];

// On POSIX the systemd unit name and the launchd label belong to the launcher step, which
// those systems do not have yet. Answering from a guessed name would report another service
// as this one, so the adapter refuses instead of inventing a convention it does not own.
for (const platform of ["linux", "darwin", "aix"]) {
  assert.throws(() => serviceAdapter(platform), { code: "REMOTE_PLATFORM_UNSUPPORTED" }, platform);
}
checks.push("unimplemented-service-backends-fail-loudly");

const win32 = serviceAdapter("win32");

// A name ends up inside a PowerShell script, so the accepted set is bounded and every name is
// escaped rather than filtered: the product's names are constants, and a caller that could
// pass anything would be able to run a query for something else.
const script = win32.startupQueryScript(["O'Brien"]);
assert(script.includes("'O''Brien'"), "a quote must be doubled rather than removed");
assert(script.includes("'Schedule.Service'"), "the state must come from the COM API, whose values are numeric");
assert(script.includes("GetTasks(1)"));
for (const names of [[], ["a", "a"], ["a", ""], [42], ["x".repeat(129)]]) {
  assert.throws(() => win32.startupQueryScript(names), { code: "STARTUP_QUERY_NAMES_INVALID" }, JSON.stringify(names));
}
checks.push("query-names-are-escaped-and-bounded");

const definition = { name: "ThriftyRelay MCP", path: "\\", state: "Ready", actionCount: 1, actionValid: true };
const read = output => win32.readStartupDefinitions({
  names: ["ThriftyRelay MCP"],
  run: async source => { assert(source.includes("'ThriftyRelay MCP'")); return output; },
});
assert.deepEqual(await read(JSON.stringify({ tasks: [definition] })), [{ count: 1, ...definition }]);
// ConvertTo-Json collapses a one-element array, and a host with nothing registered answers
// with no tasks at all: the first must read as one definition and the second as none.
assert.deepEqual(await read(JSON.stringify({ tasks: definition })), [{ count: 1, ...definition }]);
assert.deepEqual(await read(JSON.stringify({ tasks: [] })), []);
checks.push("definition-is-read");

// A half-parsed answer would let the caller act on something the host never said, so a
// definition that does not match the shape is a failure rather than a best effort.
for (const [rejected, output] of [
  ["unparsable", "{"],
  ["unknown-name", JSON.stringify({ tasks: [{ ...definition, name: "Other" }] })],
  ["unknown-state", JSON.stringify({ tasks: [{ ...definition, state: "Readyish" }] })],
  ["action-count-type", JSON.stringify({ tasks: [{ ...definition, actionCount: "1" }] })],
  ["action-validity-type", JSON.stringify({ tasks: [{ ...definition, actionValid: "yes" }] })],
  ["single-task-invalid", JSON.stringify({ tasks: {} })],
  ["more-tasks-than-names", JSON.stringify({ tasks: [definition, definition] })],
]) {
  await assert.rejects(read(output), { code: "STARTUP_QUERY_FAILED" }, rejected);
}
await assert.rejects(win32.readStartupDefinitions({
  names: ["ThriftyRelay MCP"],
  run: async () => { throw new Error("the shell refused to start"); },
}), { code: "STARTUP_QUERY_FAILED" });
await assert.rejects(win32.readStartupDefinitions({ names: [], run: async () => "{}" }), { code: "STARTUP_QUERY_NAMES_INVALID" });
checks.push("broken-answer-fails-loudly");

console.log("PASS: " + checks.join(", "));
