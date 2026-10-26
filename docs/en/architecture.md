[日本語](../ja/architecture.md) | English

# ThriftyRelay architecture

Use this reference to trace a request from MCP submission to saved results and understand replay prevention and review evidence.
ChatGPT plans the work, delegates it, and judges completion.
The server admits requests, executes them, and persists the records.
For installation see [setup](setup.md).
For daily operation see [operations](operations.md).
For request fields and task procedures see [delegation](orchestration.md).

## Purpose and scope

The design keeps ChatGPT able to judge from real files and command results without re-executing a write whose outcome is unknown.
The scope covers the MCP server, the Codex adapter, the CLI, per-OS credentials and process operations, and the task store.
The external tunnel, Codex SDK/CLI, Desktop Commander, and ChatGPT host provide the services used by these components.

On Windows this checkout is both the development source and the launcher of the running MCP.
A running process keeps the code it loaded, while a newly spawned worker reads the current files.
Check active work and locks before you change runtime code or restart.
The [operations guide](operations.md#update-and-restart-cautions) lists the switch conditions.

## Terms

| Term | Meaning |
| --- | --- |
| Tunnel API key | The OpenAI API key that `tunnel-client` uses to connect the tunnel. Setup stores it in the OS credential store. |
| Workspace | The directory Codex works in. Codex requests are checked against it. |
| Temporary work area | A separate directory where a request with `scratch: true` gets a folder of its own. |
| Task store | The directory where ThriftyRelay keeps request, task, and conversation records. Uninstall keeps it. |
| Admission policy | A file an administrator registers. It selects the Codex worker's sandbox and which steps need approval. Without one, enforcement is off. |
| Write scope | The paths a Codex request declares it will write. Admission uses it to decide which writers may overlap; it does not limit what Codex can write. |
| Unknown outcome | A write whose result could not be confirmed. ThriftyRelay keeps its records and does not run it again; see [recovery](recovery.md). |
| Execution lock, scoped lease | The record that a writer is running. One left by an unknown outcome blocks new writers until recovery. |

## System context

~~~mermaid
flowchart LR
  U[User] --> C[ChatGPT]
  C --> T[External tunnel]
  T --> M[Local stdio MCP]
  M --> D[Desktop Commander, etc.]
  M --> W[Codex worker]
  W --> S[Codex SDK and CLI]
  M --> P[Task store]
  S --> F[Working files and external services]
~~~

### Tools

- Public task tools: `health`, `remote_task`, `remote_inspect`.
- View tools: `open_settings` opens settings on an explicit request; `open_approval` opens a pending-approval card.
- App-only tools: `settings_update`, `pending_approvals`, `approval_step`, `approve_task`, `decline_task`.

[server.mjs](../../src/server.mjs) is the authoritative source for the public schema and visibility.
An ordinary tool call does not open the settings view.

### UI resources

- Settings: `ui://thriftyrelay/settings-v2.html`
- Approval: `ui://thriftyrelay/approval-v1.html`

### Build metadata

Icons are data URIs: a 64×64 PNG and a 20×20 single-color SVG.
The SDK's high-level registration drops icons, so schemas and metadata come back through the low-level tools/list.
The source hash covers every module the server and its workers load, plus the icons, locales, and app pages it reads; `tests/test-source-build.mjs` checks the module list against the import graph.

## Main components

| Component | Responsibility | Implementation |
| --- | --- | --- |
| MCP server | Schema, tool registration, source consistency check, step execution | [server.mjs](../../src/server.mjs) |
| Task Manager | Asynchronous execution, waiting, cancellation, final recording | [task-manager.mjs](../../src/mcp/task-manager.mjs) |
| Codex adapter and worker | Request matching, conversation, model selection, SDK execution, result formatting | [adapter.mjs](../../src/codex/adapter.mjs), [worker.mjs](../../src/codex/worker.mjs) |
| Execution arbitration | Global exclusion, per-scope leases, retention when the outcome is unknown | [execution-guard.mjs](../../src/mcp/execution-guard.mjs), [scope-leases.mjs](../../src/mcp/scope-leases.mjs) |
| Admission policy and approval | Validation of registered policies, per-operation decisions, approval card | [admission.mjs](../../src/mcp/admission.mjs) |
| Evidence and quota | File hash comparison, SDK command evidence, quota retrieval | [review-evidence.mjs](../../src/codex/review-evidence.mjs), [quota-gate.mjs](../../src/codex/quota-gate.mjs) |
| CLI and platform layer | setup, doctor, per-OS paths, credentials, process operations | [cli.mjs](../../scripts/cli.mjs), [platform](../../src/platform) |
| POSIX supervisor | State recording, background execution, owned process group | [background.mjs](../../src/runtime/background.mjs), [supervisor.mjs](../../src/runtime/supervisor.mjs) |

## Request lifecycle

A Codex request is a single asynchronous step.
It needs an explicit `permissions=full-access`, a dedicated absolute cwd, and a persistent `request_id`.
The cwd must match the canonical configured workspace or be a subdirectory of the configured temporary work area.
The adapter refuses filesystem roots and the user's home directory.
`readOnly=true` is refused with `CODEX_READONLY_UNAVAILABLE`.
A registered admission policy can narrow the worker's actual sandbox below what the request fields describe.
See the [admission contract](admission.md).

Admission checks authentication, the request format, explicit scopes, and quota.
The quota is read before dispatch, and again immediately before a resend that approves a warning.
Warnings, blocks, and unavailability are separate outcomes, and an unknown write is never retried automatically.
The [settings reference](settings.md#quota-thresholds) is the contract for quota thresholds and approval.

The request tombstone is persisted before execution starts.
A resend with the same ID and the same intent returns the original task, and an expired result output is no reason to re-execute.
A content change under the same ID is refused.
A request without scopes uses global exclusion, and a request with explicit scopes uses a shared lease.
The execution slot is reserved before the snapshot and the worker launch.
For the rollout conditions of concurrent live admission, see the [admission contract](admission.md#current-rollout-blockers).

The worker uses a fixed OpenAI provider, the ChatGPT sign-in method, and the default service tier.
It uses no API key and does not switch to another provider.
The adapter checks the ChatGPT token in `auth.json`, so compatibility with keyring-only authentication is unresolved.
Existing AGENTS.md, Skills, MCP, and plugin configuration can affect the work. The worker's standard subagent feature stays disabled.
Model and tool availability depends on the user's own entitlements.

### Model and conversation compatibility

A request names `model_role` (`base` or `upper`), and the adapter resolves it from the saved `baseModel` or `upperModel` setting before the request is recorded.
The [settings reference](settings.md) lists the supported model and effort pairs.
A new request without a role uses the base model; a continuation without one keeps the conversation's last successful model and effort, and a role on a continuation switches it with the same `conversation_id`.
A failed change does not switch to another model.

The current dependency is Codex SDK 0.162.1.
Conversation records use version 2 and request records use version 3.
A request record in any other format is refused with `CODEX_REQUEST_RECORD_INVALID` and never re-executed.
The fingerprint includes the resolved model and effort and any explicit `write_scopes`.
A downgrade to an older version is unverified, and different implementation versions must not share one store at the same time.

### Waiting for completion and cancellation

After a request, wait with `remote_inspect({task_id})`.

| Setting or event | Behavior |
| --- | --- |
| Default `wait_ms` | 120000 milliseconds, also the maximum. |
| `wait_ms: 0` | Immediate diagnostic response. |
| Wait expires while the task runs | Returns a short in-progress response. Wait again with the same task ID. |
| Completion notification | Uses the same process, with no extra inference or periodic disk polling. |
| Client or tunnel timeout | Independent of the server's 120-second maximum. |

This wait uses neither Work nor MCP Events.

Completion is judged after the final save and lock processing.
The wait reloads the persistent record after that save, so the answer reflects the saved state.
A completed Codex task returns the answer, the review, and usage together.
`step_index` still retrieves one saved output.
General multi-step tasks keep the contract of a summary plus individual outputs.

Disconnecting or cancelling a wait request releases only that wait's timer and listeners.
Stopping work takes an explicit `action=cancel` or the existing execution deadline.
A cancellation request and a stop confirmation are separate, and a stop confirmation does not undo external side effects that already happened.
A task owned by another process, interrupted, or left with an unknown outcome keeps that state; it is not marked successful and not re-executed.
A lock with an unknown outcome stays held until [recovery with approval and audit](recovery.md).

## Review evidence and observation limits

For `task_type=code`, the server hash-compares the real files in the cwd before and after the step inside the reserved execution slot.
The baseline includes the dirty state at the start, so this difference is not the Git HEAD difference.
`expected_files` is an optional array of relative file names, and unexpected changes are classified only when you specify it.
The list is separate from admission permission.
The review JSON is saved under `codex/reviews` in the task store.
An unknown outcome keeps the comparison that was obtained, and nothing is deleted automatically.

| Evidence | Limit |
| --- | --- |
| File comparison | 2000 directory entries, including files; 32 MiB total; 4 MiB per file; depth 20. |
| Excluded paths | `.git`, `node_modules`, and symbolic-link traversal. |
| SDK `command_execution` events | Up to 12 events; each command and output up to 600 characters. Includes omitted count and truncation flag. |
| Answer | 8000 characters, with truncation stated. |

- Limit overruns, access failures, or changes during scanning make the comparison incomplete.
- Interruptions can leave command evidence incomplete.
- Files outside the cwd and external-service effects are outside the comparison.
- Out-of-scope changes do not identify their writer; `strict_scope_verified:false` remains.

Review JSON stores no duplicate bodies or Git diffs; use read/run to inspect the needed content.
Assess the answer, file comparison, command output, and exit codes together before ChatGPT judges completion.

Diagnostics for an SDK failure cover the launch stage, a fixed failure category, whether the thread started, the event count, and a safe HTTP status.
Raw exception text, stacks, stderr, URLs, and credentials never reach storage or the display.
When the worker exits without a result, the record keeps the last confirmed stage and the exit code that could be obtained.
Diagnostics narrow down the cause of a failure.

Usage is the SDK's token count, which differs from the remaining plan amount and from the API billed amount.
On completion, the App Server's `account/rateLimits/read` runs once for up to 8 seconds, and the response attaches the remaining percentages and reset times of the five-hour window and the weekly window to limits.
A window that the response omits is null, a failed retrieval is `status=unavailable`, and the task still counts as complete.
The values are a snapshot collected by another process.

## Persistence and locking

Images from read and call come back as MCP image content and are saved as task attachments.
The text character limit and secret masking apply to text, and image data has its own byte limits.
Supported formats are PNG, JPEG, GIF, and WebP.
One image is at most 8 MiB, and a step and the whole task are each limited to 4 images and 8 MiB in total.
Task output cleanup deletes the matching image attachments. Read inside Code Mode returns text only.

Participating writers use the same canonical task store.
They use the global-exclusion `active.lock`, the maintenance `maintenance.lock`, and the short per-scope admission gate and leases, each for a different purpose.
A bridge keeps mutual exclusion between scoped leases and legacy writers.
The [admission contract](admission.md) is authoritative for declarations, conflicts, and unknown handling, and [recovery](recovery.md) is authoritative for release conditions.
Manual editors, other stores, unsupported legacy implementations, and detached work fall outside this exclusion.

Task output cleanup keeps the latest 100 entries and protects the records of incomplete tasks, unknown outcomes, active locks, and similar cases.
Cleanup leaves request tombstones, conversation metadata, and recovery audits in place.
The original request cannot be re-executed after its output expires.
A moved store keeps its tombstones and audits, and old requests are not resent to a new empty store.
Codex manages SDK session history and shared caches itself.

## Security boundaries

The cwd and the write scopes are not an OS sandbox.
The registered policy, the SDK sandbox, execution arbitration, and post-execution review are separate controls, and each covers a different part of the work.
Local checks and audits serve the same user, and a program with that user's access rights can read the same evidence.

The tunnel API key comes from the OS credential store or from an explicitly specified temporary environment variable.
It goes into the tunnel's child environment, and the MCP bootstrap removes credentials before loading the main body.
Processes of the same user may be able to inspect the initial environment or the credential store.
On macOS, a Keychain write briefly places the secret in argv, and this path is unverified on a physical Mac.
[SECURITY.md](../../SECURITY.md) holds the detailed trust model and the reporting scope.

## Deployment and execution modes

Windows supports a logon task, a manually started task, and foreground in the original terminal.
Linux and macOS use POSIX manual mode, where you choose the background supervisor or `--foreground`.
Setup registers no systemd or launchd unit for automatic start.
POSIX manages state, a short start lock, and the owned process group, and it refuses to start as UID 0.

The source, authentication, the OS launcher, and the persistent task store live in separate locations.
[operations](operations.md) lists the per-OS paths and stop conditions, and the [design record](setup-doctor-design.md) gives the reasoning for each mode.
The source hash in `health` identifies differences between the loaded source snapshot and files on disk.
The npm package is private today, so npx distribution after publication and a fixed install location are not implemented.

## Verification and remaining issues

Static checks, fixtures, OS integration verification, a real tunnel, a real ChatGPT connection, and real model use are separate verification scopes.
[CONTRIBUTING.md](../../CONTRIBUTING.md) is authoritative for the CI configuration and the retention conditions for dedicated test areas.
Keychain behavior and behavior on a physical Mac need their own check, even when CI runs on macOS.

The open items are:

- Integration verification of independent scoped concurrent admission
- Recovery verification, including partial failure
- Keyring-only Codex authentication compatibility
- Complete cleanup when a Windows terminal ends
- Connection verification of MCP Apps with the real approval card
Publication also needs a security review and installation verification in a clean environment.
A formal third-party security audit has not been performed.
