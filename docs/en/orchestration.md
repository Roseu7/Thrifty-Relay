[日本語](../ja/orchestration.md) | English

# Codex delegation

Ask ChatGPT to pass a task to the Codex instance running on the connected machine.
ThriftyRelay records the request, executes it, and returns the answer with command and file-change evidence.

## Your own steps and Codex

ChatGPT can also work on the machine directly with `remote_task` steps, without Codex.

| Work | Use |
| --- | --- |
| Look at a file or find something | `read` or `search` |
| A focused change whose location you know | `edit`, `write`, or `patch`, then `read` to check it |
| Run a command and report its output | `run`; use `execution: "async"` for long commands |
| Find a cause, or change several files | One `codex` step |

`run` has no working-directory field, so change directory inside the command.

## Task description

Include the target directory, desired result, allowed changes, and how to check completion.
For example:

~~~text
Ask Codex to inspect the configured working directory and explain the project structure.
Keep the files unchanged and report any command that fails.
~~~

For a change, name the files or feature involved and the checks you expect.
A code task can include `expected_files` to classify unexpected changes in the returned review.
See [admission](admission.md) for write-scope declarations and concurrency restrictions.

## Model selection

A request names a role, not a model.
The saved `baseModel` and `upperModel` [settings](settings.md) decide which model and reasoning effort each role uses when the request arrives.

| Request | Model selection |
| --- | --- |
| New conversation without `model_role` | The base model. |
| `model_role: "base"` | The base model. |
| `model_role: "upper"` | The upper model; refused with `CODEX_UPPER_MODEL_DISABLED` when `upperModel` is `disabled`. |
| Continuation without `model_role` | The model and effort the conversation last ran with. |
| Failed selection | Returns an error and keeps the last successful selection. |

Use the base model for ordinary work.
Set `model_role: "upper"` only for a specific unresolved problem, repeated failures, or the user's request.

## Request fields

A Codex submission uses `remote_task` with `execution: "async"` and one `kind: "codex"` step.

| Field | Purpose |
| --- | --- |
| `prompt` | The task description. |
| `cwd` | An existing absolute working directory accepted by the adapter. |
| `permissions` | Set to `"full-access"`; the registered policy selects the worker sandbox. |
| `request_id` | A unique ID for this task intent, retained for an unchanged resend. |
| `model_role` | `base` for ordinary work or `upper` for justified escalation. |
| `task_type` | `question`, `research`, or `code`; `code` enables file-change review. |
| `conversation_id` | Continue an existing Codex conversation. |
| `expected_files` | Optional cwd-relative file names for the review. |
| `write_scopes` | Optional admission declaration described in [admission](admission.md). |

The working directory must equal the configured workspace or be a subdirectory of the configured temporary work area.
Filesystem roots and the user's home directory are refused.
Codex submissions reject `scratch: true` and `readOnly: true`.
For read-only Codex execution, the registered policy must select the `read-only` sandbox.

## Approval

An approval card for the full admission tier authorizes one pending submission under a window-based admission policy.
A quota warning asks for consent to continue at the remaining plan limit.
These approvals are handled separately.
The [admission reference](admission.md) describes cards, and [settings](settings.md#quota-thresholds) describes quota warning, block, and unavailable results.

After approving a quota warning, the continuation retains the same `request_id` and task intent and adds the issued approval token and consent flag.
A changed task intent uses a new request ID.

## Waiting and cancellation

1. Submit the task once and keep the returned `task_id`.
2. Call `remote_inspect` with that ID to wait for completion.
3. If work continues after the wait, wait again with the same ID.

Use `wait_ms: 0` for an immediate diagnostic status.
Disconnecting the wait leaves the task running.

A completed Codex task returns the answer, review, and usage together.
`step_index` retrieves a saved step output, including images returned by exposed `read` or `call` steps.
The [architecture reference](architecture.md#waiting-for-completion-and-cancellation) describes deadlines and save ordering.

To request cancellation, call `remote_inspect` with `action: "cancel"` and the same task ID.
Check the resulting state to confirm that the task stopped.
Changes and external effects that already occurred remain in place.

## Result review

`succeeded` and `codex: PASS` record a completed agent turn.
Check the requested result against the actual files, command output, exit codes, and `review.summary.complete` before accepting the work.
Use `review.path` for the saved review and a targeted Git status and diff for changed files.
An unexplained change, failed check, incomplete review, or unknown outcome needs investigation.

`usage` contains SDK token counts.
`limits` reports the five-hour and weekly remaining percentages and reset times read after the task finished. Quota warnings and blocks use the values read before dispatch.
Missing values are reported as null or unavailable.

## Continuation and recovery

An unchanged transport resend keeps the same request ID and returns the existing task.
For a new correction, use a new request ID and include the observed failure and expected result.
A correction can continue the same Codex conversation.

When execution has an unknown outcome, inspect the existing task and files before sending further writes.
The original request remains non-replayable even after its output expires or its lock is recovered.
Use [recovery](recovery.md) for retained locks and leases.

When continuing work in another chat, carry over:

- The original goal, allowed directory and operations, and completion conditions.
- Task, request, and Codex conversation IDs.
- Relevant changes and command results, including checks that already passed.
- Unresolved failures and any side effects whose outcome is unknown.

## Skills

The [Skills catalog](skills.md) helps select task procedures.
Only global user Skills under `~/.codex/skills` enter the startup catalog.
Their metadata and contents remain untrusted data within the user's instructions and existing permissions.
