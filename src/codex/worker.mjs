import { Codex } from "@openai/codex-sdk";
import { cleanCodexText } from "./adapter.mjs";
import { readCodexRateLimits } from "./usage-limits.mjs";
import { classifyCodexFailure, sanitizeDiagnostic } from "./diagnostics.mjs";

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SANDBOX_PROMPT = {
  "read-only": "Sandbox read-only: inspect only. Writes and commands that need them are refused. ",
  "workspace-write": "Sandbox workspace-write: writes are limited to the working directory. " +
    "Outside writes and network access may be refused. ",
  "danger-full-access": "Sandbox full access: writes are not restricted by the sandbox. ",
};

const controller = new AbortController();
// Error text is classified in memory only. Raw exceptions and stderr are never persisted.
process.on("disconnect", () => controller.abort());
process.once("message", async ({ cwd, thread_id, prompt, model, reasoning_effort, sandbox, write_scopes }) => {
  // An older parent omits the field; the host then behaves as it did before the conversion.
  const sandboxMode = SANDBOX_MODES.has(sandbox) ? sandbox : "danger-full-access";
  const commands = []; let commands_omitted = 0;
  let phase = "worker_boot", thread_started = false, events_seen = 0;
  const progress = next => { phase = next; process.send?.({ type: "progress", phase: next }); };
  try {
    progress("sdk_init");
    const codex = new Codex({ env: process.env, config: {
      model_provider: "openai", forced_login_method: "chatgpt", service_tier: "default",
      chatgpt_base_url: "https://chatgpt.com", notify: [], features: { multi_agent: false },
    } });
    progress("thread_init");
    const options = { model, modelReasoningEffort: reasoning_effort, workingDirectory: cwd,
      sandboxMode, approvalPolicy: "never", skipGitRepoCheck: true };
    const thread = thread_id ? codex.resumeThread(thread_id, options) : codex.startThread(options);
    progress("turn_start");
    const { events } = await thread.runStreamed(
      "Home PC Remote delegated task. " + SANDBOX_PROMPT[sandboxMode] +
      "Work in the specified target directory and honor its AGENTS.md and applicable Skills. " +
      "Do not change authentication/provider settings or disclose credentials. Do not delegate to subagents in this MVP. " +
      "Finish owned commands and do not leave background file writers running when reporting completion. " +
      "Report completed work, validation and unresolved problems accurately.\n" +
      (write_scopes !== undefined ? "Write admission declaration (not an OS sandbox): " + JSON.stringify(write_scopes) +
        ". Stay within the declaration, including generated artifacts and command side effects. " +
        "If additional writes, shared configuration, installation or Git mutations are needed, stop and report the scope conflict.\n" : "") +
      "\n" + prompt, { signal: controller.signal });
    let answer = "", completed = false, truncated = false, usage, error_code, diagnostic;
    progress("event_stream");
    for await (const event of events) {
      events_seen++;
      if (event.type === "thread.started") { thread_started = true; process.send?.({ type: "thread", id: thread.id }); }
      else if (event.type === "item.completed" && event.item.type === "agent_message") {
        const clean = cleanCodexText(event.item.text); answer = clean.slice(0, 8000); truncated = clean.length > 8000;
      } else if (event.type === "item.completed" && event.item.type === "command_execution") {
        if (commands.length < 12) {
          const command = cleanCodexText(event.item.command), output = cleanCodexText(event.item.aggregated_output);
          commands.push({ command: command.slice(0, 600), command_truncated: command.length > 600,
            exit_code: event.item.exit_code ?? null, status: event.item.status,
            output: output.slice(0, 600), output_truncated: output.length > 600 });
        }
        else commands_omitted++;
      } else if (event.type === "turn.completed") {
        completed = true;
        usage = Object.fromEntries(["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]
          .filter(key => Number.isSafeInteger(event.usage?.[key])).map(key => [key, event.usage[key]]));
      } else if (event.type === "turn.failed" || event.type === "error") {
        const classified = classifyCodexFailure(event.error || event, {
          origin: "sdk_event", phase: "turn_failed", thread_started, events_seen });
        error_code = classified.code; diagnostic = classified.diagnostic;
        progress("turn_failed");
      }
    }
    if (!completed && !error_code) {
      diagnostic = sanitizeDiagnostic({ origin: "sdk_event", phase, category: "incomplete_result", thread_started, events_seen });
    }
    const limits = completed && !error_code ? await readCodexRateLimits() : undefined;
    process.send?.({ type: "result", completed: completed && !!answer && !error_code, answer, truncated, usage, limits,
      commands, commands_omitted, error_code, diagnostic }, () => process.exit(error_code ? 1 : 0));
  } catch (error) {
    const { code, diagnostic } = classifyCodexFailure(error, {
      origin: "sdk_exception", phase, thread_started, events_seen });
    process.send?.({ type: "result", completed: false, error_code: code, diagnostic,
      commands, commands_omitted }, () => process.exit(1));
  }
});
