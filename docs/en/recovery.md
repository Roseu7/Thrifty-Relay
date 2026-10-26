[日本語](../ja/recovery.md) | English

# Recovery of unknown executions

Use recovery after you have investigated a retained execution lock or a scoped lease and can attest to the review of processes, files, and external effects.
Recovery releases a reviewed admission barrier.
Changes stay in place, the original task outcome does not change, and the request stays non-replayable.
Do not use it to cancel healthy work or to get a restart past an unknown result.

Confirm that detached work stopped by checking process identity and descendant evidence.
Unrecorded detached jobs, operations already sent to external applications and services, and effects outside the workspace need your own review.
The confirmation and audit form an operational trail only.
They add no authentication boundary against a process that already holds the user's access.

## Inspection before recovery

Use the same task store as the affected runtime.
For the default Windows task store, run this read-only inspection in PowerShell:

~~~powershell
node scripts/remote-maintenance.mjs inspect --task-dir "$env:LOCALAPPDATA\ThriftyRelay\tasks"
~~~

The low-level command requires an explicit absolute `--task-dir`.
Use the [platform path](operations.md#state-and-logs) on Linux/macOS, or the path saved by setup for a custom store.

- Inspection returns lock hashes, stored process identities, current process evidence, retention information, and any scoped summary.
- Review detached jobs and external services separately; they are outside that inventory.
- Preserve task, request, conversation, lock, lease, review, and audit records.
- Keep `active.lock`, `maintenance.lock`, `admission.lock`, and lease files until the reviewed recovery releases them.

Review each kind of evidence before approval.

### Processes

Compare recorded PIDs and start identities with current workers and descendants.
Establish that owned work stopped, and investigate unrecorded or detached work.

### Files

Compare actual changes with the pre-task baseline.
Include potentially affected files in these categories:

- Generated
- Untracked
- Ignored
- Outside Git
- Outside the workspace

### External operations

Review the following:

- Network requests
- Services and applications
- Deployments
- Queued or detached operations

Record unknowns instead of claiming a rollback.

Do not include tunnel API keys, tokens, raw credential output, or other secrets in evidence.
Git status and diff summaries support the review.
They do not cover ignored paths or show who made a change.
The legacy guided preview works from the ThriftyRelay checkout.
Inspect any other affected workspace separately.
The scoped preview uses the scoped workspace.

## Guided recovery

~~~sh
thriftyrelay recover
~~~

For an installation configured to use `~/thriftyrelay-tasks`, select that store explicitly:

~~~sh
thriftyrelay recover --task-dir "$HOME/thriftyrelay-tasks"
~~~

| Item | Behavior |
| --- | --- |
| Store selection | Explicit `--task-dir`, then `THRIFTYRELAY_TASK_DIR`, then the [platform default](operations.md#state-and-logs). |
| Confirmation | Local interactive terminal for input and output. No unattended approval flag. |
| Language | `--lang ja` or `--lang en`. |
| Recovery type | Selected from the observed store: scoped or legacy, without conversion. |

The saved setup value `taskDirectory` is not read automatically.
Confirm that the selected store matches the live installation before continuing.

## Scoped lease procedure

The guided path accepts an unknown lease, or a running lease whose recorded owner has died, when the remaining safety checks pass.
It requires exactly one lease in the registry and exactly one recoverable candidate.
While another lease remains, it refuses and keeps every lease instead of choosing a release order.

1. Review the namespace, registry and bridge hashes, task ID, lease ID, request ID, conversation ID, owner, and recorded processes.
2. Enter the displayed task ID and lease ID exactly when asked.
   A partial or mismatched selection is refused.
3. Review the process, file, and external-effect evidence.
   The command refuses release while a recorded worker or descendant is live, while the owning task is active, or while the evidence is unavailable.
4. Review the freshly probed process list immediately before confirmation.
   Enter uppercase `YES` after you finish the checks.
   Any other answer cancels approval.
5. Let the backend revalidate the control, registry, and bridge hashes and namespace, the lease and bridge tokens, the task, request, and conversation relationships and file hashes, and the process evidence.
   A changed process set after approval is refused.
6. Read the final result and audit ID.
   The command checks that the selected barriers are gone.
   A partial-failure code needs investigation, not another blind recovery run.

Before release, the backend persists an audit intent under `codex/recovery/<audit-id>.json`.
It records the task as `interrupted` with `execution_unknown:true`, the request as `reviewed_unknown`, and the conversation as `interrupted`.
Under the short admission gate it releases the selected last lease and bridge, then records `guard_state: "recovered"`.
The task keeps its original outcome, and the request stays non-replayable.

## Legacy procedure

With a legacy global execution lock, `thriftyrelay recover` displays the bound task, lock hash, stored identities, current process evidence, and the review checklist.
The guided frontend refuses an unfinished task record or a running task, even when the PID is absent.
After the review it accepts `y` or `yes` in any case, unlike the uppercase `YES` of scoped recovery.
The backend rechecks the exact lock and process evidence and holds a maintenance gate.
It writes an audit intent before release, updates associated records, and writes a receipt.
Unknown effects stay unknown, and the original request cannot run again.

For legacy or incomplete records that you reviewed separately, the lower-level procedure remains available.
For the default Windows store:

~~~powershell
node scripts/remote-maintenance.mjs recover --task-dir "$env:LOCALAPPDATA\ThriftyRelay\tasks" --approval "$HOME/thriftyrelay-recovery-approval.json"
~~~

Save the reviewed approval record as `~/thriftyrelay-recovery-approval.json` before running the command.
It binds the exact task ID and the full lock SHA-256, with the operator identity or reference and the process, file, and external-effect evidence.
Legacy or incomplete identity records also need the explicit legacy-process review attestation defined in [recovery.mjs](../../src/mcp/recovery.mjs).
At the local terminal, type the exact displayed phrase `UNLOCK <task_id> <first-12-lock-hash>`.
Do not synthesize this approval to work around a guided refusal.
Resolve the cause and get the separate review first.
The legacy backend refuses scoped bridge or registry state with `REMOTE_SCOPED_RECOVERY_UNAVAILABLE_ROLLOUT_BLOCKED`.
Use the scoped procedure for scoped state.

## Refusal and partial-failure reference

| Condition or code | Response |
| --- | --- |
| `REMOTE_LOCAL_INTERACTIVE_CONSOLE_REQUIRED` | Run from a local TTY. Do not automate confirmation. |
| `REMOTE_MAINTENANCE_LOCKED_INSPECT_REQUIRED` | Keep the gate and inspect its owner and audit intent. Normal recovery does not remove it. |
| `REMOTE_SCOPED_OTHER_LEASES_ACTIVE` | Leave all leases intact. Current recovery cannot release one lease among several. |
| `REMOTE_SCOPED_SELECTION_MISMATCH` | Reinspect the intended task and lease. Do not substitute an approximate ID. |
| `REMOTE_OWNER_TASK_STILL_ACTIVE`, `REMOTE_SCOPED_LEASE_OWNER_ACTIVE` | Establish that the owning work stopped. Age or PID absence alone is insufficient. |
| `REMOTE_OWNED_PROCESS_STILL_ALIVE` | Stop the owned work through its authorized path and review it first. |
| `REMOTE_PROCESS_EVIDENCE_UNAVAILABLE` | Repair the evidence-gathering context. Incomplete descendant enumeration, including the Windows 256-level bound, can miss processes. |
| `REMOTE_LOCK_CHANGED`, `REMOTE_PROCESS_EVIDENCE_CHANGED` | The reviewed snapshot is stale. Keep state and investigate before any new approval. |
| `REMOTE_SCOPED_RECORD_MISMATCH`, `REMOTE_RECOVERY_RECORD_UNAVAILABLE` | Unlocking cannot repair missing, inconsistent, or unreadable records. |
| `REMOTE_HUMAN_APPROVAL_REQUIRED` | Release needs the exact local confirmation. |
| `REMOTE_RECOVERY_AUDIT_UNAVAILABLE` | Release needs a durable audit intent. |
| `REMOTE_RECOVERY_POST_RELEASE_RECORD_FAILED` | Scoped release happened, and the final task recording is unconfirmed. Inspect the audit and the store before further writes. |
| `REMOTE_RECOVERY_AUDIT_UPDATE_FAILED` | Scoped release happened, and the final audit update is unconfirmed. Preserve the reported audit ID and the evidence. |

If recovery crashes with a maintenance barrier, inspect the owner and the audit before a separately authorized maintenance operation.
Drain every participating wrapper and use one operator.
Do not remove a barrier on a timeout, and do not treat a missing owner as proof that all effects stopped.
No unattended force unlock exists.

## Limits and rollout status

Independent dynamic verification of scoped recovery, process evidence, partial failures, and audit consistency remains a live rollout blocker.
Process evidence here is best-effort.
Detached-work tracking stays incomplete, and recovery behavior on a physical Mac is not covered.
Keep recovery records with the corresponding request tombstones.
See [admission](admission.md) for declarations versus enforcement, [architecture](architecture.md) for persistence, and [operations](operations.md) for guarded restart.
