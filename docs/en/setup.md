[日本語](../ja/setup.md) | English

# ThriftyRelay setup

Run setup in an interactive terminal, from the directory you want Codex to work in.
It saves configuration and prepares the startup mode you select.

For an existing Windows installation, [check running work first](operations.md#update-and-restart-cautions): setup can replace the launcher and task definition and stop the running task.

- [Prerequisites](#prerequisites)
- [Platform status](#platform-status)
- [Windows setup](#windows-setup)
- [Linux and macOS setup](#linux-and-macos-setup)
- [Connect ChatGPT](#chatgpt-connection)
- [Success criteria](#success-criteria)
- [Doctor reference](#doctor-reference)

## Prerequisites

Use Node.js 22 or later, npm, and Git on Windows, Linux, or macOS.
Clone the repository, install its dependencies, and link the `thriftyrelay` command:

~~~sh
git clone https://github.com/Roseu7/Thrifty-Relay.git
cd Thrifty-Relay
npm ci
npm install -g .
~~~

`npm ci` runs as the root project, so the dependency overrides in `package.json` apply.
Installing straight from a GitHub URL or the npm registry skips those overrides and installs dependency versions with known vulnerabilities.
`npm install -g .` links the command to the clone, so ThriftyRelay always runs from it; keep the clone in place.
npm may warn that the `thrifty-relay` install script was not allowed; `npm ci` has already run it.
If npm's global directory needs administrator rights on your system, only the link step needs them; ThriftyRelay itself refuses to run as root.

Prepare the following before running setup.

| Item | What to prepare |
| --- | --- |
| Codex sign-in | Sign in to the Codex CLI with your ChatGPT account. See [authentication requirements](#codex-authentication). |
| Tunnel ID and API key | Create them in the [tunnel settings](https://platform.openai.com/settings/organization/tunnels). Authorize the key for that tunnel. |
| Tunnel executable | Download a compatible binary from [tunnel-client releases](https://github.com/openai/tunnel-client/releases). |
| ChatGPT workspace | Use ChatGPT on the web with permission to add a custom MCP server. See [Connect ChatGPT](#chatgpt-connection). |
| Workspace | Choose an existing, dedicated directory and supply its absolute path. Filesystem roots and the whole home directory are rejected. |
| Temporary work area | Choose a separate absolute path, or accept the platform default. See [temporary work area](#temporary-work-area). |

Setup asks you to confirm the Codex sign-in; it does not run login or check model access.
It links to the tunnel settings and releases when needed, but creating the tunnel and downloading the binary are separate steps.

### Setup input

| Prompt | Input |
| --- | --- |
| Language | `ja` or `en`. |
| Paths | Absolute paths. Enter accepts the displayed default; invalid paths prompt again. |
| Tunnel ID | A saved ID appears as the default with its middle hidden. First-time setup has no ID default. |
| Yes/no | Enter `y`, `n`, `yes`, or `no`, in any case. There is no default. |
| Tunnel API key | Enter at the hidden prompt, or choose to reuse a saved key. |

Press Ctrl+C to cancel setup.

- A save or registration already in progress finishes before cancellation; setup then stops before the next step.
- Saved settings and registrations stay in place. Cancellation does not uninstall an existing installation.
- If this setup started a Windows task, it checks that the task stopped. An unconfirmed stop is reported as an error.

## Platform status

| Platform | Startup | Tested in CI | Not yet verified |
| --- | --- | --- | --- |
| Windows | Logon task, on-demand task, or foreground | All offline suites, including the PowerShell suites | Cleanup after closing a foreground terminal, and non-elevated control of a highest-run-level task |
| Linux | Manual `start`, in the background or the foreground | Offline suites, runtime integration, and a real Secret Service | Nothing beyond the [known limitations](../../SECURITY.md#linux-and-macos) |
| macOS | Manual `start`, in the background or the foreground | Offline suites and POSIX runtime state tests | Keychain behavior and running on a physical Mac |

CI never connects to ChatGPT or runs real models; see [contributing](../../CONTRIBUTING.md) for what each suite covers.

## Windows setup

Run from this checkout:

~~~powershell
thriftyrelay setup
~~~

1. Enter the values listed under [Setup input](#setup-input).
2. Choose whether to start at Windows logon. If not, choose whether to register a task for manual startup.
3. Approve the UAC prompt for a task mode, then wait for the local startup check.

| Mode | Startup and lifetime | How setup finishes |
| --- | --- | --- |
| `on-login-task` | A Windows logon task starts the runtime for the user at logon. | Starts the task and returns after the readiness check. |
| `on-demand-task` | A task has no logon trigger and is started explicitly. | Starts the task and returns after the readiness check. |
| `foreground` | Runs in the setup/start terminal without registering a task. | Reports startup and remains attached. |

| Task setting | Value |
| --- | --- |
| Name | `ThriftyRelay MCP` |
| Launcher | `%LOCALAPPDATA%\ThriftyRelay\Start-ThriftyRelay.ps1` |
| Registration | One UAC approval; `InteractiveToken` and `HighestAvailable`. |
| Window | Hidden PowerShell. Use [status and logs](operations.md#state-and-logs). |
| API key storage | Windows Credential Manager. |

Windows rejects `mode: "manual"`.
For foreground mode, stop ThriftyRelay with Ctrl+C in its own terminal; another terminal's `stop` cannot take ownership.
Cleanup of descendant processes after closing that terminal remains unverified.

## Linux and macOS setup

Run as the intended non-root user:

~~~sh
thriftyrelay setup
~~~

Enter the values listed under [Setup input](#setup-input).
Setup saves `mode: "manual"`, `taskDirectory`, and `tempWorkspace`; startup is a separate step.
POSIX accepts only `manual` and installs no systemd or launchd unit.

| Platform | API key storage | Startup dependency |
| --- | --- | --- |
| Linux | `secret-tool` with a reachable session Secret Service over D-Bus and a usable keyring. | `ss` |
| macOS | `/usr/bin/security` with the login Keychain. | `lsof` |

If credential storage fails, setup keeps the configuration and reports the failure, such as `CREDENTIAL_BACKEND_UNAVAILABLE`.
It does not save a plaintext key; doctor reports backend failures as `CREDENTIAL_BACKEND_ERROR`.

Resolve the credential source, then start the runtime:

~~~sh
thriftyrelay start
~~~

By default, `start` launches a detached background supervisor and returns when startup succeeds.
To keep the runtime in this terminal, use:

~~~sh
thriftyrelay start --foreground
~~~

- Missing `ss` or `lsof` produces `RUNTIME_DEPENDENCY_MISSING`. Stop can use the recorded process group if the other ownership checks pass.
- Running as UID 0 produces `RUNTIME_AS_ROOT`.
- Background mode survives terminal exit; logout or reboot can stop it.
- Keychain behavior and execution on a physical Mac still need verification.

<a id="temporary-runtime-key"></a>
### Temporary tunnel API key

When a credential backend is unavailable, an operator's secret manager or hidden terminal input can supply `THRIFTYRELAY_RUNTIME_KEY` for a single invocation.
The platform credential adapter gives this nonempty environment value precedence over the OS store and does not persist it.
Remove it from the caller's environment afterwards.
Do not put a literal key in shell history, a script, a config file, or the repository.
A Windows scheduled task reads its saved Credential Manager entry, so a temporary value in the caller's shell does not replace task credential setup.

The tunnel receives the key as `CONTROL_PLANE_API_KEY` in its child environment.
The configured `scripts/sanitized-mcp.mjs` bootstrap removes the temporary tunnel API key override and tunnel credentials before it imports the MCP entrypoint.
The runtime does not put the key in its config or in tunnel command arguments.
The macOS Keychain write does use the secret in `security` command arguments, which is a known exposure during that write.
A process that runs as the same user may inspect the initial environment or the credential store.
This handling reduces accidental inheritance; it is not an OS security boundary.

## Start, stop, restart, and check

Use the [operations command table](operations.md#daily-lifecycle) for daily commands and platform-specific behavior.
`--foreground` is accepted only for POSIX `start` and `restart`.
For an existing live Windows MCP, use [Windows MCP control](operations.md#windows-mcp-control) and `mcp:restart` for full writer-lock protection.

<a id="chatgpt-connection"></a>
## Connect ChatGPT

ChatGPT connects to ThriftyRelay on your PC through OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
The local `tunnel-client` retrieves requests over outbound HTTPS and forwards them to the MCP server, which can stay private.
Add ThriftyRelay as a custom MCP server in ChatGPT on the web.
Keep ThriftyRelay and `tunnel-client` running during discovery and tool calls.

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins).
2. Select the plus button, then **Add custom MCP server**.
3. Enter `ThriftyRelay` as the name and, optionally, a short description.
4. Under **Connection**, select **Tunnel**, then choose the tunnel or enter its `tunnel_id`.
5. Select **No authentication** for ThriftyRelay.
6. Review the risk warning, select **I understand and want to continue**, then select **Create as a plugin**.
7. Review the discovered tools and metadata, install the plugin, and start a new conversation.
8. Type `@` in the prompt box, select `ThriftyRelay`, and ask it to call `health`.

The current [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) uses this Plugins flow.

### Authentication

ThriftyRelay's MCP server does not implement OAuth.
Separately, `tunnel-client` authenticates to OpenAI with the tunnel API key that setup stores in the OS credential store.

### Access permissions

Access to custom MCP connections and tools depends on your ChatGPT plan, [account permissions and workspace settings](https://developers.openai.com/api/docs/guides/custom-mcp-server), and feature rollout.

- The [OpenAI Help Center](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) lists Full MCP for Business, Enterprise, and Edu, and describes Pro custom MCP connections as read/fetch-only.
- The current [Plugins connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) includes testing write operations that need authorization or confirmation.

On ChatGPT Plus, adding ThriftyRelay as a plugin and running its tools works in the maintainer's environment.
Availability can still differ by account and rollout, so call `health` after connecting and try the operations you plan to use.
If you cannot add a custom MCP server, check those settings.

- In a managed workspace, ask the administrator to check **Create plugins with MCPs** and the permissions to use the plugin and its tools.
- If the tunnel is missing, check its association with the target ChatGPT workspace and the operator's Tunnels **Read + Use** permission in the Platform organization.

### Legacy Connectors UI

The following is a reference procedure only for environments that actually display the legacy Connectors screen:

1. Open **Settings > Connectors**.
2. Open **Advanced settings** and enable **Developer mode**.
3. Return to **Connectors**, select **Create**, and configure **Tunnel** with the same tunnel ID.

### Refresh tool definitions

After a restart changes tool definitions, open the plugin at [ChatGPT Plugins](https://chatgpt.com/plugins), select **Refresh**, and start a new conversation.

### Public distribution

Secure MCP Tunnel supports private custom MCP connections.
[Public submission of a remote MCP plugin](https://developers.openai.com/plugins/deploy/submission) requires a stable, publicly reachable HTTPS MCP endpoint.
This remote MCP submission requirement is separate from open-source distribution of ThriftyRelay's source or an npm package.

## Success criteria

Run the read-only diagnostics:

~~~sh
thriftyrelay status --json
thriftyrelay doctor
~~~

| Check | Expected result |
| --- | --- |
| Setup | Configuration saved, API key accessible, and selected startup mode prepared. POSIX needs a separate `start`. |
| Windows task startup | Local `/readyz` returns HTTP 200 within the default 60 seconds. |
| Foreground startup | Tunnel identity, listener ownership, and `/readyz` HTTP 200 verified. |
| Windows process check | Task and managed processes verified. |
| Intentionally stopped manual/foreground mode or idle on-demand task | `PASS / STOPPED_IDLE`. A stopped logon task has a different status. |

On Windows, run `thriftyrelay mcp check` to verify the task and managed processes.
Doctor alone can report `LOCAL_ENDPOINT_UNVERIFIED` even when the endpoint responds.

Then connect ChatGPT as described in [Connect ChatGPT](#chatgpt-connection).
Ask ChatGPT to call ThriftyRelay's `health` tool.
Try a small Codex task under the intended authorization, and check the approval card when required.

These host checks verify discovery, model access, and card behavior separately from local startup.

## Codex authentication

The [Codex adapter](../../src/codex/adapter.mjs) reads `CODEX_HOME/auth.json`, which defaults to `~/.codex/auth.json`.

| Requirement | Value |
| --- | --- |
| Authentication mode | `auth_mode: "chatgpt"` |
| Token | An access token must be present. |
| API key record | Rejected. |
| Keyring-only sign-in | Compatibility with this file-based check is unverified. |

Setup leaves Codex authentication unchanged.
Keep existing authentication and organization policy; do not copy tokens into this project or convert credentials to satisfy this guide.

## Temporary work area

Setup saves the absolute path as `tempWorkspace` and creates the directory, using mode 0700 where supported.

| Platform | Default |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ThriftyRelay\temp` |
| Linux | `$XDG_CACHE_HOME/thriftyrelay/temp` when `XDG_CACHE_HOME` is absolute; otherwise `~/.cache/thriftyrelay/temp`. |
| macOS | `~/Library/Caches/ThriftyRelay/temp` |

Keep this area separate from the following locations:

- Codex workspace
- Task store and recovery evidence
- Configuration and runtime state directories
- Installation directory and source checkout

Setup checks real paths, including existing ancestor links and any not-yet-created tail, and asks again if paths overlap.
Keep credentials out of this area.

### Temporary requests

For an ordinary `remote_task`:

1. Add `scratch: true` to create `<tempWorkspace>/<task_id>/`.
2. Use relative `path`, `file_path`, `cwd`, or patch paths, or use `{{scratch}}` in a command.
   They resolve inside that task directory; a path escaping it, including `{{scratch}}/..`, is rejected.
3. Use an absolute path when the target is elsewhere.
   Absolute paths receive normal admission checks.

For Codex, use an absolute `cwd` that is either:

- The canonical configured workspace itself
- A subdirectory of the temporary root

Codex rejects `scratch: true`.

To skip approval for ordinary reads and writes here, an administrator adds the exact path to the registered policy's `scratch_roots` and registers it again.
Setup prints this step but does not perform it; without the entry, existing approval behavior applies.
Commands, code, tool calls, and Codex retain their tier and sandbox rules.
The [admission policy](admission.md) selects the Codex worker sandbox.

Move intended deliverables to the workspace before the task succeeds.

| Task result | Cleanup |
| --- | --- |
| Success | Removes the task's own directory. |
| Failure | Retains unprotected data for up to 7 days. |
| Active task, unknown execution, or recovery evidence | Protected from cleanup. |

Removable data is also subject to the 100-entry and 1 GiB caps.
See [admission](admission.md#temporary-work-area-and-scratch_roots) for the full scratch contract.

## Doctor reference

Doctor reports the checks below.
`status` summarizes the local state in one or two lines; `status --json` and `doctor --json` return the detailed checks.
They observe configuration and current state; they do not start, repair, register, or update anything.

| ID | What it checks | Representative codes |
| --- | --- | --- |
| `environment` | Node version, installed Codex SDK, and platform native binary. | `ENV_READY`, `ENV_POSIX_READY`, `ENV_NODE_RECOMMENDED`, `ENV_SDK_MISSING`, `ENV_NATIVE_BINARY_MISSING` |
| `config` | Readable JSON, supported platform mode, and an absolute workspace. | `CONFIG_READY`, `CONFIG_NOT_INSTALLED`, `CONFIG_INVALID`, `CONFIG_MODE_INVALID`, `CONFIG_INCOMPLETE` |
| `credentials` | Whether the selected environment or OS credential source can supply the tunnel API key. | `CREDENTIAL_REGISTERED`, `CREDENTIAL_UNCONFIGURED`, `CREDENTIAL_BACKEND_ERROR` |
| `startup` | Windows task definition or selected foreground/manual mode. | `STARTUP_TASK_REGISTERED`, `STARTUP_TASK_INVALID`, `STARTUP_FOREGROUND_CONFIGURED`, `STARTUP_MANUAL` |
| `readiness` | Loopback response and, for a recorded POSIX runtime, listener ownership/state. | `STOPPED_IDLE`, `LOCAL_ENDPOINT_UNVERIFIED`, `RUNTIME_RUNNING`, `RUNTIME_FAILED`, `RUNTIME_STATE_STALE` |
| `policy` | Whether an administrator-registered admission policy can be read and validated. | `PASS / POLICY_REGISTERED`, `WARN / POLICY_UNREGISTERED`, `WARN / POLICY_UNVERIFIED` |

`RUNTIME_OWNER_MISMATCH` is FAIL.
`RUNTIME_OWNER_UNKNOWN`, `RUNTIME_DEPENDENCY_MISSING`, `RUNTIME_IN_TRANSITION`, and `LOCAL_READINESS_UNKNOWN` are UNKNOWN.
Investigate ownership failures before stopping a process.
The [operations troubleshooting table](operations.md#troubleshooting) explains the next steps.

Each JSON item contains `id`, `status`, `code`, and optional limited `evidence`.

| Exit code | Condition |
| --- | --- |
| `1` | At least one FAIL. |
| `2` | No FAIL and at least one UNKNOWN. |
| `0` | All other cases, including WARN alone. |

Check policy enforcement and the host connection separately from the diagnostic exit code.
See [admission](admission.md) for registration and the server behavior associated with the policy check.

Configuration, task-store, and log paths are listed in [operations](operations.md#state-and-logs).
To remove an installation, use the preview and guarded removal in [uninstall](operations.md#uninstall).
Saved user preferences are described in [settings](settings.md).
