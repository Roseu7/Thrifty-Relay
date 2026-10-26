[日本語](../ja/settings.md) | English

# Settings reference

Open the [terminal editor](#terminal-tui), use [CLI commands](#non-interactive-commands), or ask ChatGPT to open the [settings view](#optional-mcp-apps-view).
These interfaces change user preferences; setup, credentials, paths, policy registration, and recovery have separate controls.

Settings share one non-secret [configuration file](operations.md#state-and-logs).
Setup also saves `tempWorkspace` there, but the settings UI does not change that path.
Definitions are in [src/config.mjs](../../src/config.mjs) and [src/cli/settings.mjs](../../src/cli/settings.mjs).

## Saved values

| Field | Allowed values | Default or initial behavior |
| --- | --- | --- |
| `language` | `ja`, `en` | Use the OS locale when absent, then `en`. |
| `baseModel` | A model/effort pair from the table below | `gpt-6-luna/max` |
| `upperModel` | A supported pair or `disabled` | `gpt-6.1-sol/medium` |
| `maxCodexAgents` | Integer 1–5 | 3 |
| `reviewPolicy` | `conditional`, `always`, `manual` | `conditional` |
| `fiveHourLimitPercent` | Integer 0–100 | 10 |
| `weeklyLimitPercent` | Integer 0–100 | 10 |
| `fiveHourLimitAction` | `warn`, `block` | `warn` |
| `weeklyLimitAction` | `warn`, `block` | `warn` |

Supported model and effort pairs:

| Model | Effort choices |
| --- | --- |
| `gpt-6-luna` | `medium`, `high`, `max` |
| `gpt-6.1-sol` | `medium`, `high` |
| `gpt-6.1-terra` | `medium`, `high`, `max` |

Missing fields in older config files receive defaults, and reading does not rewrite the file.
An explicitly saved `gpt-6.1-sol/high` stays selected when the upper-model default changes.
Saving updates the config atomically and preserves unrelated non-secret fields.
Invalid values and unknown settings keys are rejected.

## Terminal TUI

~~~sh
thriftyrelay settings
~~~

The editor needs terminal input and output.

| Action | Keys |
| --- | --- |
| Select a field or choice | Up/Down |
| Open choices or save a value | Enter |
| Return without saving | Esc |
| Exit from the main screen | Esc or `q` |
| Edit a threshold | Type an integer from 0 through 100; Ctrl+U clears the input. |

- Recommendations appear in parentheses only when they differ from the current value. Language has no recommendation.
- Review and threshold-action explanations appear on the editing screen.
- Numeric errors appear below the input and clear on the next keypress.

Without ANSI support, the editor uses numbered menus.
Select the field number, then a choice or a numeric percentage.
For numeric input, Enter with no value returns to the field menu.

## Non-interactive commands

~~~sh
thriftyrelay settings show
thriftyrelay settings show --json
thriftyrelay settings set maxCodexAgents 3
thriftyrelay settings set fiveHourLimitPercent 25
thriftyrelay settings set weeklyLimitPercent 10
thriftyrelay settings set fiveHourLimitAction warn
thriftyrelay settings set weeklyLimitAction block
~~~

The `set` command accepts `maxCodexAgents` and the exact quota field names shown above.
`baseModel`, `upperModel`, and `reviewPolicy` have no setter here.
Use the TUI or the settings view for those fields.
Run `thriftyrelay lang ja` or `thriftyrelay lang en` to save the language.
Quota percentages must be decimal integers from 0 to 100, without a percent sign or leading zeros.

`settings show --json` returns the locale-independent `settings`, `sources`, `recommended`, and `options`.
Percentage options use `{ "min": 0, "max": 100, "step": 1 }`.
The MCP settings view receives localized labels and choice data.

`--lang ja` or `--lang en` selects the command display language without saving it.
Normal language resolution is explicit override, saved language, OS locale, then English.
`settings show` resolves an absent saved language independently from the display override, so a translated heading does not mean the saved language changed.

## Quota thresholds

Each new Codex request reads both the five-hour and weekly quota windows before task reservation.
At or below a threshold, its action applies, and a block takes precedence when both windows trigger.
After warning approval, the request reads both windows again immediately before execution.

| Outcome | Code | Required action |
| --- | --- | --- |
| A `warn` threshold is reached | `CODEX_QUOTA_APPROVAL_REQUIRED` | Show both remaining percentages, thresholds, and reset times; obtain explicit user approval. No worker has started. |
| A `block` threshold is reached | `CODEX_QUOTA_BLOCKED` | Do not dispatch or retry automatically. Approval cannot override a block. |
| Either window is unavailable | `CODEX_QUOTA_UNAVAILABLE` | Do not dispatch or retry automatically, regardless of the configured action. |
| Quota config cannot be read | `CODEX_QUOTA_CONFIG_UNAVAILABLE` | Resolve the configuration failure before a deliberate new attempt. |

To continue after a warning:

1. Obtain the user's explicit approval.
2. Resend the same `request_id` and unchanged task intent.
3. Add only `quota_warning_approved=true` and the issued `quota_approval_token`.

The token binds that intent and request ID; keep it out of prompts, reports, and logs.
The saved approval flag records ChatGPT's report of consent.
A 0% threshold still triggers at 0%.

Quota windows are plan-limit snapshots, separate from SDK token usage and API billing.
Completion-time limits are a separate snapshot, so missing completion-time data leaves a completed task completed.
See [architecture](architecture.md) for result evidence and [orchestration](orchestration.md) for the approval and retry workflow.

## Optional MCP Apps view

An explicit request to open or view settings lets ChatGPT call `open_settings`.
A compatible host loads `ui://thriftyrelay/settings-v2.html`.
Other hosts receive readable text for the same settings and can edit them with the terminal commands.
Ordinary `health`, `remote_task`, and `remote_inspect` calls do not open this view.

The view uses the MCP Apps bridge to submit changes to app-only `settings_update`.
Only the settings fields are accepted, and the payload carries no credentials, startup settings, tunnel configuration, filesystem paths, system management, or lock recovery.
The view keeps no preferences in browser local storage.
Rendering and live interaction depend on the host.
After an authorized source deployment, use the guarded restart and host schema refresh described in [operations](operations.md#update-and-restart-cautions).

## What settings control

`baseModel` and `upperModel` decide the model and effort for the two roles ChatGPT can request: `base` for ordinary work and `upper` for escalation.
A request reads them when it arrives, so a change applies to the next request and leaves running tasks alone.
A new Codex conversation without a role uses the base model, while a continuation keeps the model and effort it last ran with.
With `upperModel=disabled`, a request for the upper role is refused with `CODEX_UPPER_MODEL_DISABLED`.

`reviewPolicy` guides ChatGPT.
`conditional` reviews according to the task, `always` requests review of completed code changes, and `manual` requests review only when asked.

`maxCodexAgents` limits newly admitted explicit scoped leases in the shared task store.
Changing it does not stop existing leases.
Omitting `write_scopes` keeps legacy global exclusion, and `expected_files` grants no admission.
A write scope is a declaration, not an OS sandbox.
Live scoped concurrency rollout stays blocked until independent integration tests pass.
See [admission](admission.md) for the full contract and [recovery](recovery.md) for retained unknown leases.
