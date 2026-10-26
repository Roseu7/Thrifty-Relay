[日本語](../ja/admission.md) | English

# Admission and write scopes

Use this reference to configure access rules, understand approval cards, or declare Codex write scopes.

Admission decides whether a request may begin and which participating writers may overlap.
Path containment for arbitrary full-access work sits outside that decision.
Keep the administrator-registered policy, a task's write-scope declaration, and post-execution review evidence separate.

## Administrator-registered admission policy

Policy registration is separate from setup.

| Registration state | Doctor result | Server behavior |
| --- | --- | --- |
| No registration | `WARN / POLICY_UNREGISTERED` | Legacy behavior without policy enforcement. |
| Valid registration | `PASS / POLICY_REGISTERED` | Applies the policy. |
| Existing registration cannot be read or validated | `WARN / POLICY_UNVERIFIED` | Blocks admission. |

Registration is an explicit local administrator operation:

~~~sh
thriftyrelay register-policy --file "$HOME/thriftyrelay-policy.json"
~~~

Save the reviewed policy document as `thriftyrelay-policy.json` in your home directory before running the command.
Run the registration as your normal user; the script requests administrator elevation itself on Windows and POSIX.
Do not prefix the command with `sudo`, and run ThriftyRelay itself as the non-root user.
Do not register a policy as an incidental setup repair.
The validated registration locations are `C:\ProgramData\ThriftyRelay\policy.json`, `/etc/thriftyrelay/policy.json`, and `/Library/Application Support/ThriftyRelay/policy.json`.
See [policy schema and validation](../../src/platform/policy.mjs) and [registration CLI](../../scripts/register-policy.mjs) before preparing a policy.

The server evaluates known path operations and privileged step kinds under the registered policy.
For Codex, the policy tier selects the worker sandbox.

| Tier | Sandbox | Registration |
| --- | --- | --- |
| standard | `read-only` | Public tier. |
| trusted | `workspace-write` | Internal mapping. |
| full | `danger-full-access` | Public tier. |

The public Codex request still requires `permissions: "full-access"` and rejects `readOnly=true`.
That request field does not override a narrower sandbox from a registered policy.

Shell, arbitrary tool, and code-mode steps require the full tier, because a path declaration cannot describe all their runtime targets.
An already authorized full-access child can still reach protected paths.

### Policy fields

| Field | Value |
| --- | --- |
| `generation` | Positive integer. A draft can use 1; registration assigns the next generation from the current policy. |
| `kill_switch` | Boolean that stops full access when true. |
| `full_access` | Mode plus positive integer `max_minutes` and `max_concurrent` values, except in `denied` mode. |
| `tunnel_ids` | Nonempty list of tunnel IDs approved for this installation. |
| `workspace_roots` | Nonempty list of absolute paths for ordinary file access. |
| `scratch_roots` | Optional absolute paths for temporary file access. |
| `protected_paths` | Optional absolute paths protected in addition to the server's own files. |

Keep tunnel IDs local when sharing an example policy.

### Policy modes

| `full_access.mode` | Behavior |
| --- | --- |
| `window` | Full access requires an approval bound to one submission. |
| `persistent` | Requests use full access without an approval window. |
| `denied` | The registration does not permit full access. |

`kill_switch: true` prevents full access regardless of the mode.
In window mode, `max_minutes` bounds approval validity and `max_concurrent` bounds concurrent windows.
Approval count has no daily limit.
New registrations omit the retired `max_per_day` field, and existing values are ignored.

### Approval cards

1. `remote_task` returns `APPROVAL_REQUIRED` and a task ID.
2. Open that submission with `open_approval`. The card shows planned paths and loads step bodies when expanded.
3. Choose approval or decline. The server atomically claims the record and checks its ten-minute expiry again.

| Decision or failure | Result |
| --- | --- |
| Approve | Opens and consumes a window bound to the task ID and steps, then starts an asynchronous task with that ID. |
| Decline or expiry | Closes the submission without opening a window. |
| Scratch root changed since submission | Invalidates the submission and asks for a new one. |
| Window cannot open | Restores the pending record for another attempt. |
| Window consumption fails | Keeps the claim for inspection. |
| `TASK_START_FAILED` | The window has already been consumed. Inspect the task ID and retained claim before proceeding. |

The app-only `pending_approvals`, `approval_step`, `approve_task`, and `decline_task` tools supply the list, details, and actions.
Declined, expired, and invalidated decisions remain for 24 hours, up to 100 records.
Saved decisions take precedence over uncleared claims.
A claim without a task or decision appears as processing or unconfirmed; conflicting pending and claimed records are refused.
This admission approval is separate from [quota-warning consent](settings.md#quota-thresholds) and [recovery approval](recovery.md).

## Temporary work area and scratch_roots

Setup creates a per-user temporary work area and saves its absolute location as `tempWorkspace`.
It is separate from the workspace root and from the internal task store.
The per-platform default paths are listed in [operations](operations.md#state-and-logs).
An explicit `THRIFTYRELAY_TEMP_WORKSPACE` takes precedence, then the saved `tempWorkspace`, then the platform default.
The default is a location only and does not by itself change admission.

A registration opts in with an optional `scratch_roots` array of absolute paths:

~~~json
{"scratch_roots": ["C:\\Users\\example\\AppData\\Local\\ThriftyRelay\\temp"]}
~~~

Classification order is protected, sensitive, scratch, workspace, outside.
A name such as `.env` inside a scratch root stays sensitive, and a protected path stays protected.

Ordinary `read`, `write`, `edit`, and `patch` steps in a registered scratch root need no approval window.
`run`, `code`/`call`, and Codex steps still require their existing tier, and a scratch path grants no full access.
Paths outside every scratch root keep the existing behavior.

### Scratch paths

An ordinary request with `scratch: true` creates `<tempWorkspace>/<task_id>/` and an `owner.json` naming the task.

| Path | Resolution |
| --- | --- |
| Relative `path`, `file_path`, `cwd`, `patch.files[].path` | Inside the task directory. |
| `{{scratch}}` in `run.command` | Expands to the task directory. |
| Absolute path | Used as written, with normal admission checks. |
| Relative path escaping the directory, including `{{scratch}}/..` | `SCRATCH_PATH_ESCAPE` before an approval card is created. No window is spent. |
| Symlink or junction | The real target is classified again at execution and checked under its target tier. |

At standard or trusted tier:

- A directory owned by another task is refused.
- An existing sibling directory without an owner record is refused.
- The scratch root itself is refused with `ADMISSION_SCRATCH_ROOT_SCOPE`, because searching it would traverse sibling tasks. Name the task's own directory or a file directly under the root.

Full tier retains full-access behavior.

Codex accepts an absolute `cwd` in a subdirectory of the configured scratch root, not the root itself.
Its policy-selected sandbox is unchanged.
Codex rejects `scratch: true` with `CODEX_SCRATCH_UNSUPPORTED`; use `cwd` so execution and cleanup do not refer to different directories.

### Scratch retention

| State | Retention |
| --- | --- |
| Confirmed success | Removes the task's own scratch directory. |
| Failure | Retains unprotected data for up to 7 days. Both synchronous and asynchronous summaries show `Scratch retained: <path>`. |
| Removable data exceeds 100 entries or 1 GiB | Removes the oldest eligible entries until both limits are met. |
| Active task | Excluded from cleanup and both budgets. |
| `guard_state=unknown`, `execution_unknown`, or recovery evidence | Protected from cleanup. |
| Task record exists but cannot be read or parsed | Protected as potentially unresolved. Only a record proven absent can age out as an orphan. |

Cleanup checks only direct child directories whose names match task IDs and whose `owner.json` names the same task; it does not follow links.
Task-history pruning uses the same protection rule and keeps recovered or unresolved records while their directory remains.
Uninstall leaves scratch data in place for separate review.

## Explicit write_scopes contract

Only one asynchronous Codex step may carry this declaration.
Use cwd-relative files or directories, or the literal string `"global"`:

~~~json
{"write_scopes": [{"kind": "file", "path": "src/example.mjs"}]}
~~~

~~~json
{"write_scopes": [{"kind": "directory", "path": "src/feature"}]}
~~~

~~~json
{"write_scopes": "global"}
~~~

A declaration array holds 1–100 entries with only `kind` and `path`, and each path is at most 240 characters.
The directory and its traversed contents must already exist and be verifiable.
A file may be new if its parent exists.
Absolute paths, traversal, wildcard-style paths, links and reparse points, hard-linked files, unsupported file types, and unverifiable paths are refused.
`.git`, `node_modules`, and shared configuration cannot be isolated through an individual declaration or a containing directory declaration.

Declare every generated file, test artifact, and command output that can be written.
Shared configuration, dependency installation, Git mutations, and effects that cannot be limited need global admission.
This is a caller obligation: a path declaration does not enforce an OS write boundary.
`expected_files` describes expected changes for later review only.
It infers no scopes, authorizes no write, and reserves no lease.

An explicit declaration participates in the v3 request fingerprint, so do not reuse a request ID with a different declaration.
Omitting the field preserves the existing v3 and legacy v2 matching rules and uses legacy global exclusion.
Verifiably invalid declarations are rejected before request tombstones, and admission conflicts fail before worker launch.
There is no automatic execution queue and no automatic retry of a conflicting request.

## Concurrency and locks

All participating processes must use the same canonical task store and a compatible implementation.
The short `admission.lock` serializes registry changes.
The lease is reserved before the worker and before the review workspace snapshot.
An `active.lock` scope bridge excludes legacy global writers while scoped leases exist.
Ordinary read and search steps can stay concurrent.
A legacy writer cannot pass as read-only to bypass coordinated exclusion.

| Combination | Admission behavior |
| --- | --- |
| Disjoint explicit file or directory scopes | Backend can admit concurrent leases up to `maxCodexAgents`, default 3, range 1–5. |
| Intersecting file or directory scopes | Refused; directory scopes include descendants. |
| Global declaration or a legacy global writer | Exclusive with participating scoped writers. |
| Same Codex `conversation_id` | Never concurrent, even across ChatGPT conversations or MCP processes. |
| Unknown lease, unknown registry state, or maintenance barrier | Blocks new writes and protected restart until investigated. |

A new conversation ID is created before admission, so it also participates in exclusion.
The worker PID is persisted before execution proceeds, and identity evidence is refreshed at startup, thread notification, and spaced progress events.
A failure to persist process evidence requests worker stop and retains an unknown lease.
Confirm that descendant processes stopped; a normal response or Node wrapper exit does not show that on its own.
Unobserved detached work cannot be tracked completely.

The implementation lives in [scope-leases.mjs](../../src/mcp/scope-leases.mjs), [adapter.mjs](../../src/codex/adapter.mjs), and [task-manager.mjs](../../src/mcp/task-manager.mjs).
Manual editors, unrelated tools, separate stores, old implementations, and external service operations fall outside this coordination guarantee.

## Declaration versus enforcement

Write scopes coordinate participating writers.
The registered policy selects the Codex sandbox separately.
Full-access child processes and other programs under the same user can reach files outside the declared scopes.

Code-task review reports `admission.outside_declaration_observed` and `strict_scope_verified:false`.
It hashes cwd before and after, so it can show that files under cwd changed.
Attribution to one concurrent writer, strict compliance, and external side effects need other evidence.
The review excludes `.git` and `node_modules` and has file, byte, and depth limits described in [architecture](architecture.md).
Do not treat an observed outside-scope difference as a proven violation by a particular worker without further evidence.

## Current rollout blockers

The scoped backend and local per-lease recovery are implemented.
Live scoped concurrency rollout stays blocked until independent integration tests pass.
Treat this as an operational rollout restriction; no feature flag enables it.
Do not activate live parallel requests because the schema exists, the MCP restarted, or a focused fixture passed.

Remaining independent verification includes concurrent writers across processes, unknown and partial-failure paths, last-lease recovery refusal behavior, process evidence changes, and audit consistency.
The recovery procedure deliberately refuses selection while any other lease remains.
Windows process observations do not establish POSIX recovery behavior or detached-process cessation.
Use [recovery](recovery.md) for evidence requirements and [operations](operations.md#windows-mcp-control) for guarded restart conditions.
