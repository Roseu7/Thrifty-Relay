[日本語](../ja/operations.md) | English

# ThriftyRelay operations

Run these commands as the user who installed ThriftyRelay, with the same task store.
For first installation and the doctor check table, see [setup](setup.md).

## Daily lifecycle

Choose the command for the operation you need.
Before stopping or restarting, inspect active tasks, unknown outcomes, and execution locks.
Cancelling a Codex job is a separate operation from stopping ThriftyRelay.

| Operation | Command |
| --- | --- |
| Start | `thriftyrelay start` |
| Short state summary | `thriftyrelay status` |
| Detailed checks and totals | `thriftyrelay doctor` |
| Detailed checks as JSON | `thriftyrelay status --json` or `thriftyrelay doctor --json` |
| Stop | `thriftyrelay stop` |
| Restart in the saved mode | `thriftyrelay restart` |

Diagnostics are read-only; a WARN can coexist with exit 0.
For guarded Windows task-store writer protection, use [Windows MCP control](#windows-mcp-control).

### Windows task mode

- `start` uses `ThriftyRelay MCP` and its saved launcher.
- `stop` stops the task and the verified configured tunnel listener tree.
- `restart` stops those processes, then starts the task.

### Windows foreground mode

- `start` stays in the launching terminal.
- Press Ctrl+C in that terminal to stop it.
- A different terminal's `stop` or `restart` cannot take ownership.
- Closing the terminal can leave descendant processes running.

### Linux and macOS manual mode

- `start` launches a background supervisor; `start --foreground` stays attached.
- `stop` and `restart` use the recorded owned process group, including foreground work started in another terminal.
- `restart --foreground` starts an attached replacement after stopping the recorded runtime.
- An existing running or starting instance is reported instead of starting a duplicate.
- Background mode survives terminal exit; logout or reboot can stop it.
- Setup installs no systemd or launchd unit.

## Windows MCP control

After running work finishes and the restart is authorized:

~~~powershell
thriftyrelay mcp check
thriftyrelay mcp restart
thriftyrelay mcp check
~~~

1. Run `mcp:check` to verify the local state without changing it.
2. If the check passes, run `mcp:restart`.
3. Run `mcp:check` again to verify the restarted task and processes.

Restart refuses the following states:

- Active or unknown execution
- Maintenance lock
- Scoped lease or bridge
- Locked admission gate
- Unavailable scoped registry evidence

Keep locks in place and use [recovery](recovery.md) for an unknown execution that needs an audit.

The controller validates:

- Scheduled task action
- Launcher
- Tunnel
- MCP
- Desktop Commander
- Parent relationships
- Process start identities
- Port 8080 listener

It rechecks identities before destructive actions to reduce PID reuse risk, and it checks stable managed state after startup.
Orphan cleanup is limited to identified managed processes.
Additional `node`, `codex`, or console processes are not treated as failures and are not stopped automatically.

When `MCP_PROCESS_IDENTITY_UNAVAILABLE` reports missing executable or command fingerprint evidence, stop the destructive operation.
If the installation requires it, open an administrator PowerShell explicitly and repeat the read-only check.
Do not auto-elevate, bypass the check, expose command lines, or terminate unclassified processes.
Verification is still needed for non-elevated control of a highest-run-level task.

### PowerShell requests

The controller uses one Windows PowerShell 5.1 process for each check or restart invocation and sends framed requests through its standard input.
A failed or disconnected request is not replayed automatically when its side effects are unknown.

## State and logs

| Item | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Configuration | `%APPDATA%\ThriftyRelay\config.json` | `${XDG_CONFIG_HOME:-$HOME/.config}/ThriftyRelay/config.json` | `~/Library/Application Support/ThriftyRelay/config.json` |
| Default task store | `%LOCALAPPDATA%\ThriftyRelay\tasks` | `${XDG_STATE_HOME:-~/.local/state}/thriftyrelay/tasks` | `~/Library/Application Support/ThriftyRelay/tasks` |
| Temporary work area | `%LOCALAPPDATA%\ThriftyRelay\temp` | `${XDG_CACHE_HOME:-$HOME/.cache}/thriftyrelay/temp` | `~/Library/Caches/ThriftyRelay/temp` |
| Launcher | `%LOCALAPPDATA%\ThriftyRelay\Start-ThriftyRelay.ps1` | None; manual runtime | None; manual runtime |
| Task launcher log | `%LOCALAPPDATA%\ThriftyRelay\logs\remote.log` | Not applicable | Not applicable |
| Runtime state directory | No POSIX supervisor state | `${XDG_STATE_HOME:-$HOME/.local/state}/thriftyrelay` | `~/Library/Application Support/ThriftyRelay` |

Linux honors `XDG_STATE_HOME` only when it is absolute; otherwise it uses `$HOME/.local/state`.

### POSIX runtime state

The POSIX directory holds `runtime.json`, the short-lived `runtime.lock`, and the background `runtime.log`.
`runtime.lock` can carry a reclaim guard.
`runtime.log` rotates to `runtime.log.1` at the default size limit of 5 MiB.

Foreground output stays in its terminal, and a foreground state record can still name the standard log path.
The foreground log file is separate from that record.

Directory and state validation checks ownership, permissions, file type, and path identity.
Do not replace state manually or widen permissions to bypass a refusal.

### Task store

The task store is separate from runtime state.
Its location comes from the runtime's `THRIFTYRELAY_TASK_DIR`; setup saves `taskDirectory` and supplies it to launched MCP processes.

It holds task records, `active.lock` and `maintenance.lock`, scoped registry state, `codex/requests` tombstones, conversations, `codex/reviews`, and `codex/recovery` audit receipts.
Keep these records together; an empty replacement store is a new deduplication scope.
See [architecture](architecture.md) for persistence and retention.

### Temporary work area

The area is separate from the task store and workspace.
Its path follows this order: `THRIFTYRELAY_TEMP_WORKSPACE`, saved `tempWorkspace`, then the platform default.

A `scratch: true` task uses a subdirectory named for its ID.
Success removes it; failures retain it under the [scratch retention rules](admission.md#scratch-retention).
Read [admission](admission.md#temporary-work-area-and-scratch_roots) before registering `scratch_roots` or deleting retained data.

## Uninstall

Preview the resolved targets, then run the removal:

~~~sh
thriftyrelay uninstall --dry-run
thriftyrelay uninstall
~~~

The command refuses to continue when it cannot stop the runtime or confirm its ownership.
It does not remove configuration or credentials while a recorded runtime may still be running.
Use `--yes` for a non-interactive run after you review the plan.

| Removed | Preserved |
| --- | --- |
| The running runtime and its POSIX state and log files. | The task store with its request, lock, recovery, and conversation records. |
| The `ThriftyRelay MCP` Windows task. | Codex authentication and sessions, including an overridden `CODEX_HOME`. |
| The tunnel API key in Windows Credential Manager, Linux Secret Service, or the macOS Keychain. | The administrator-registered admission policy, if one exists. |
| `config.json`, the launcher, its log, and empty product-owned directories. | Unrelated tools and their credentials. |
| | The temporary work area and any retained scratch data. |
| | Unrelated files in shared parent directories. |

| Failure or state | Next step |
| --- | --- |
| Credential-store failure | Fix the reported failure. Configuration removal has not started. |
| `UNINSTALL_INCOMPLETE` | Inspect the file-removal failure; some removal steps may have finished. |
| `UNINSTALL_RUNTIME_REPLACED` on POSIX | Inspect the replacement runtime. Its state and key are preserved. |
| Windows task stopped, but `/readyz` responds | Run `thriftyrelay stop` first. Uninstall cannot kill a port owner without tying it to the running task. |

Resolve the reported step before retrying.
Removing the task store or admission policy requires a separately reviewed operation.

## Environment variables

| Runtime input | Purpose |
| --- | --- |
| `THRIFTYRELAY_TASK_DIR` | Task store shared by participating writing processes. |
| `THRIFTYRELAY_TEMP_WORKSPACE` | Exact temporary work root; overrides the saved `tempWorkspace` and platform default. |
| `THRIFTYRELAY_TEMP_DIR` | Override for the platform default when neither `THRIFTYRELAY_TEMP_WORKSPACE` nor `tempWorkspace` is set. |
| `THRIFTYRELAY_CODEX_WORKSPACE` | Exact canonical workspace allowed at Codex entry; absent means Codex delegation is disabled. |
| `CODEX_HOME` | Existing Codex authentication/session location, when overridden. |
| `THRIFTYRELAY_RUNTIME_KEY` | Temporary credential-source override; see [key handling](setup.md#temporary-runtime-key). |
| `THRIFTYRELAY_TEST_ROOT` | Dedicated absolute test-artifact area, not the live task store. |

## Display language

Use `thriftyrelay lang` to inspect the language.
Use `thriftyrelay lang ja` or `thriftyrelay lang en` to save it.
`--lang ja` and `--lang en` override the display language for CLI, MCP control, and guided recovery commands.
Language resolution is explicit override, saved value, OS locale, then English.

<a id="update-and-restart-cautions"></a>
## Updates and restarts

This checkout is also the live MCP entrypoint.
Loaded code stays in an existing process, while a new worker may read changed files immediately.

1. Finish or safely cancel active work and inspect retained unknown outcomes before editing source or updating dependencies.
2. In the clone, run `git pull` and then `npm ci`. The linked `thriftyrelay` command picks up the update without reinstalling.
3. Review the diff, source and dependency versions, and focused checks.
4. Restart after deployment, using [Windows MCP control](#windows-mcp-control) where applicable.
5. Reconnect the host or refresh its tool definitions.
6. Ask ChatGPT to call `health`, then verify the intended task and card behavior.

Keep one implementation version per task store.
When hashed source files change after startup, `health` reports `source=changed-restart-required` and requests that may write are rejected.
Documents are excluded from the source hash and need no restart.

## Troubleshooting

| Observation | Meaning and next action |
| --- | --- |
| `STOPPED_IDLE` | Intended manual/foreground stop or idle on-demand task; start when needed. |
| `LOCAL_ENDPOINT_UNVERIFIED` | A loopback endpoint responded without sufficient runtime-owner binding. On Windows use the guarded check; do not infer ownership from HTTP alone. |
| `LOCAL_RUNTIME_STOPPED` | A configured logon-task runtime is stopped; inspect the task and launcher log. |
| `LOCAL_ENDPOINT_IN_USE` | Port 8080 is occupied. Identify its owner; do not kill a process by port number alone. |
| `RUNTIME_DEPENDENCY_MISSING` | Install or restore `ss` on Linux or `lsof` on macOS for startup ownership proof. Recorded-group stop can still work without them. |
| `RUNTIME_OWNER_MISMATCH`, `RUNTIME_OWNER_UNKNOWN` | Process or listener ownership differs or cannot be established. Preserve state and investigate; do not signal a replacement process. |
| `RUNTIME_STATE_STALE`, `RUNTIME_FAILED` | Recorded state conflicts with observation, or a start failed. Inspect the saved error and background log before retrying. |
| `RUNTIME_STATE_INSECURE` | A state path, owner, permission, or file-type validation failed. Check the intended user's path; do not bypass validation. |
| `CREDENTIAL_BACKEND_UNAVAILABLE` | Setup cannot use the POSIX store. Restore the session backend or use a deliberately temporary key source; no plaintext fallback is written. |
| `CREDENTIAL_BACKEND_ERROR`, `CREDENTIAL_UNCONFIGURED` | Doctor cannot query the credential source, or no key is present. Run under the intended user and session and revisit credential setup. |
| `CONFIG_MODE_INVALID` | Windows cannot use `manual`; POSIX requires `manual`. Reconfigure deliberately after reviewing active work. |
| `POLICY_UNREGISTERED` | WARN: no administrator registration, so admission enforcement is off. See [admission](admission.md). |
| `POLICY_UNVERIFIED` | WARN: policy validation failed; the server blocks admission instead of treating the policy as missing. Investigate the registered policy. |
| `MCP_PROCESS_IDENTITY_UNAVAILABLE` | Pause the restart. Open an administrator PowerShell and repeat `thriftyrelay mcp check`. |
| Unknown execution or a retained scoped lease | Preserve the state and follow [recovery](recovery.md). |
| `CODEX_CHATGPT_AUTH_REQUIRED` | The adapter's file-backed ChatGPT-auth requirement is unmet; setup's confirmation is not an authentication test. |
| `CODEX_QUOTA_APPROVAL_REQUIRED`, `CODEX_QUOTA_BLOCKED`, `CODEX_QUOTA_UNAVAILABLE` | Follow the distinct approval, block, and unavailable rules in [settings](settings.md#quota-thresholds). |
| A host still shows old tools | Verify the authorized restart and host reconnection or schema refresh; local readiness alone does not refresh an existing conversation. |

When execution is unknown or a scoped lease is retained, do not:

- Replay a write.
- Delete locks.
- Restart to bypass the unresolved state.

For security-sensitive reports, use [SECURITY.md](../../SECURITY.md) instead of posting keys, task records, or raw process data.
