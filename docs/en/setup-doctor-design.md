[日本語](../ja/setup-doctor-design.md) | English

# Design record for setup and doctor

Setup decides where the working directory comes from, which credential source holds the key, and how the process starts.
Doctor reports what a local check can say about that state.
This document records the current implementation and the reasoning behind those decisions.
Operating procedures are in [setup.md](setup.md), and day-to-day operation is in [operations.md](operations.md).

## Background and scope

Installation has to align the working directory, Codex authentication, the tunnel, the tunnel API key, and the startup mode.
The Windows launcher, settings storage, credentials, execution lifetime, and read-only diagnostics stay separate responsibilities.
Linux and macOS use a POSIX manual runtime, separate from OS auto-start services.

## Goals and out of scope

Installation aims to save settings in the language the user chose, to explain the startup mode and the owner, and to determine the local running state.
An intentional stop in manual mode is a valid state, distinct from a configuration fault.
Secrets stay out of non-secret config and tunnel arguments, and a credential backend failure always appears as a failure.

The installation does not include:

- Automatic Codex login
- Migration of existing authentication
- Automatic tunnel creation
- Automatic binary download
- Stopping arbitrary processes
- Automatic release of unknown outcomes
- A public npm package
- Automatic placement into a fixed controller
- systemd or launchd registration

Check the following separately from local readiness:

- ChatGPT discovery
- The host approval screen
- Real model availability

## Decisions adopted

| Decision | Reason and trade-off |
| --- | --- |
| Choose the language first | Use a language that is readable from the first guidance, and take the saved value and the OS language as defaults |
| Specify cwd explicitly | Limit Codex's start location to reduce mix-ups, but it is not an OS boundary |
| Codex login stays at the person's own confirmation | Keep existing authentication and organizational policy unchanged, and verify actual authentication compatibility separately |
| Use the existing tunnel ID and executable | Installation needs no creation permission and no download |
| Register a Windows task | Let Task Scheduler own logon startup and process lifetime, with one UAC confirmation for registration |
| POSIX starts explicitly after settings are saved | Start after confirming credentials and execution lifetime in the user session |
| Make doctor and status read-only | Keep diagnostics free of repair, registration, and stopping |
| Separate local response from owner confirmation | A response can come from another process, so doctor separates a local response from the recorded owner |
| Make an unregistered policy WARN | Surface the legacy unenforced state, even though exit code 0 still allows an unenforced policy |

## Windows startup modes

`on-login-task` runs from the person's own logon trigger, and `on-demand-task` starts manually without a logon trigger.
Both use the task name `ThriftyRelay MCP` and `%LOCALAPPDATA%\ThriftyRelay\Start-ThriftyRelay.ps1`.
The task registers with `InteractiveToken` and `HighestAvailable`, and setup for a task mode returns after registration, startup, and a readiness check.
`foreground` registers no task and keeps running in the terminal where setup/start ran.
On Windows, `manual` is invalid.

Both task modes use `-WindowStyle Hidden` in the Action of [task.mjs](../../src/platform/win32/task.mjs), so a visible task window is not available.

Stopping Windows foreground from another terminal advises Ctrl+C in the owning terminal.
Complete cleanup of descendants when the terminal closes is unverified.
Task stop in the basic CLI stops that tree only when, after the task stops, the listener on 8080 and the configured tunnel executable match.
That stop gives less protection than the execution lock of `mcp:restart`.

## POSIX manual mode

Linux and macOS setup save `mode: "manual"` and `taskDirectory`.
Setup rejects non-manual settings and does not route them to the Windows task/launcher adapter.
The manual runtime is implemented, and setup installs no systemd or launchd units.

A normal start runs the background supervisor, and `--foreground` attaches the execution to a terminal.
Both handle state recording and the owning process group, and stop/restart from another terminal confirms the recorded owner first.
Startup listener evidence needs ss on Linux and lsof on macOS, while stopping can sometimes use the recorded group.
The check confirms the PID, the start time, and the identity of the record, and refuses to act when it cannot confirm them.
This check is best effort and does not cover detached, unrecorded work.

The POSIX runtime refuses UID 0.
Staying alive after the terminal exits in background mode is separate from starting automatically after logout or an OS restart.
[operations](operations.md#state-and-logs) lists the locations of state files, start locks, and background logs.

## Doctor checks

[doctor.mjs](../../src/cli/doctor.mjs) and [cli.mjs](../../scripts/cli.mjs) return these checks.
For the code list and how to read it, see the [user reference](setup.md#doctor-reference).

| ID | Design responsibility |
| --- | --- |
| `environment` | Check the execution environment and the installed SDK/native binary |
| `config` | Check settings readability, the mode, and the working directory |
| `credentials` | Distinguish the registration state of the selected credential source from a backend failure |
| `startup` | Check the consistency of the Windows task or foreground/manual |
| `readiness` | Distinguish a local response from the recorded runtime state |
| `policy` | Show the presence and validation state of an administrator-registered policy |

`POLICY_UNREGISTERED` and `POLICY_UNVERIFIED` are WARN, and `POLICY_REGISTERED` is PASS.
A run with only WARNs exits with 0, and exit code 0 still allows an unenforced policy.
A FAIL in any check gives exit code 1; otherwise an UNKNOWN gives exit code 2.
Secrets, raw exceptions, and command lines stay out of the diagnostic JSON.

Windows doctor does not bind the responder to the saved runtime owner, so a response can still be `LOCAL_ENDPOINT_UNVERIFIED`.
POSIX reports `RUNTIME_RUNNING` when the recorded running state and the listener owner both match.
Readiness evidence therefore differs between the two systems.

## Credentials and tunnel boundaries

The tunnel API key is stored in Windows Credential Manager, Linux Secret Service, or the macOS login Keychain.
Linux needs secret-tool and a session D-Bus.
When the backend is unavailable, POSIX setup saves the settings with a warning.
No plaintext file fallback exists.
`CREDENTIAL_BACKEND_UNAVAILABLE` means the backend or a prerequisite such as secret-tool is missing.
`CREDENTIAL_BACKEND_ERROR` covers other backend failures, and doctor reports it as the credentials result.
The temporary `THRIFTYRELAY_RUNTIME_KEY` is an explicit input path that is never saved.

The tunnel receives `CONTROL_PLANE_API_KEY` in the child environment and starts the MCP bootstrap from a non-secret absolute Node command.
The bootstrap synchronously removes the known tunnel credentials and the temporary-key override before it imports the MCP itself.
Processes of the same user may be able to inspect the initial environment before removal or the credential store.
This measure limits accidental inheritance and is not an OS security boundary.
macOS also passes the secret to security's argv when saving, and that path is unverified on a physical Mac.

Codex keeps its existing authentication under the official CLI.
The adapter still requires `auth.json`, which can conflict with keyring-only authentication.
Setup's identity confirmation is not an authentication check, and installation does not migrate existing authentication.
Create tunnels and keys in the official management screen; administrator key entry and a key issuance API are not implemented.
[third-party notices](../../THIRD_PARTY_NOTICES.md) covers the handling of third-party binaries at distribution time.

## Rejected and deferred options

A detached Windows daemon without a task is not adopted.
That decision covers Windows foreground and leaves the POSIX background supervisor in place.
Bulk stopping of arbitrary processes, releasing an unknown outcome because the PID is missing or time has passed, plaintext credential storage, and an implicit rollback to the old method are not adopted.

The CLI runs from a source checkout.
Package publication and OS automatic-start management remain outside that installation path.

## Open issues and verification status

| Item | Current basis | Remaining confirmation |
| --- | --- | --- |
| Windows setup/task/foreground | Source and corresponding fixtures exist | Complete cleanup on terminal close, non-elevated context, task control from a non-elevated session |
| POSIX runtime/state | foreground/background, recording, listener verification, Secret Service tests, and CI configuration exist | The logout boundary and machine-specific conditions |
| macOS credentials | Implementation through security and fixtures exist | Keychain and a physical Mac, and the secret exposure in argv |
| Authentication | The source requires auth.json | Compatibility with keyring-only official authentication, organizational policy |
| doctor | The check list and state classification are confirmed in the source | All combinations in real environments, Windows responder binding |
| Stop and recovery | Protected MCP control and recovery with audit exist | Protection gap versus the basic CLI, contention between stopping and new admission, independent verification of partial failure |
| Settings UI | Settings fields and MCP Apps resources exist | Display and operation on a connected host |
| Scope admission | Backend and local recovery exist | Live rollout waits on independent integration verification |
