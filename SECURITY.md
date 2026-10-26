# Security policy

[日本語](docs/ja/security.md) | English

ThriftyRelay is in development and has not had a third-party security audit.
The registered admission policy selects the Codex worker sandbox.
Without a registration, Codex uses `danger-full-access` under the account running ThriftyRelay.

## Supported versions

There are no tagged releases yet.
Security fixes go to the latest commit on `main`, and older commits are not patched separately.

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**.
Please do not report them in a public issue, pull request, or discussion.
If the form is unavailable, open an issue that asks for a private contact, without any details of the vulnerability.

A useful report includes:

- the commit you tested and any local changes
- your platform and the command or MCP tool involved
- steps to reproduce, using fake data
- what happened and what you expected

Say whether you have demonstrated the problem or are describing a suspected one.
Do not attach tunnel API keys, credentials, tunnel IDs, session data, task stores, or process environments.
Test only on hosts and installations that you own or are authorized to test.

Agree on a disclosure date with the maintainer after the issue is confirmed and a fix is prepared.

## Scope and trust model

This policy covers repository code: MCP tools, CLI, setup/doctor, task persistence, admission policy handling, scoped leases, recovery, and the runtime supervisor.
Third-party binaries, OpenAI services, and the host client's controls have their own reporting routes.
An integration defect in ThriftyRelay remains in scope even when a dependency is involved.

### Worker permissions

Codex and MCP tools act with the host user's privileges, subject to any effective worker sandbox selected by a registered admission policy.
The public Codex request requires explicit `permissions=full-access` and rejects `readOnly=true`; a registered policy may still narrow the worker sandbox.
A cwd or write scope controls admission.
It does not create an OS write boundary or extend the user's authorization.

Manual editors, unrelated tools, separate task stores, detached jobs, and external services are outside coordinated lease exclusion.

### Admission policy

Admission policy registration is a separate local administrator operation.
Setup does not register it: `WARN / POLICY_UNREGISTERED` means legacy behavior with enforcement off.
An existing registration that cannot be validated blocks admission; doctor reports `WARN / POLICY_UNVERIFIED`.

A doctor WARN can return exit 0.
Treat the exit code as a diagnostic result, not a security approval.
See [admission](docs/en/admission.md) for policy enforcement versus declarations.

### Credentials

The tunnel API key is stored in Windows Credential Manager, Linux Secret Service, or the macOS login Keychain.
A temporary `THRIFTYRELAY_RUNTIME_KEY` overrides the source for an invocation without being saved.
The tunnel receives `CONTROL_PLANE_API_KEY` in its environment; the MCP bootstrap removes tunnel credentials and the override before importing the server.
Runtime configuration, tunnel arguments, and runtime logs are not intended secret stores.
However, the macOS backend writes the secret through `security` argv, which can expose it to process inspection during the write.

### Local controls

A process running as the same user may inspect the initial environment, files, or credential-store entries.
Credential scrubbing prevents accidental inheritance by MCP subprocesses.
State path, owner, permission, and file-type validation reduce accidental disclosure or replacement.
TTY confirmations and audit records provide operational evidence.
A program with full access to the PC can bypass them.

## Skills

The startup catalog reads global user Skills from `~/.codex/skills`.
Their metadata and bodies are untrusted task data and grant no additional permissions.
See [Skills](docs/en/skills.md) for discovery scope and disabling entries in `config.toml`.

## Known limitations

### Tool input validation

Each tool call accepts up to 10,000 array elements and object members in total, including nested collections.
The MCP SDK checks this limit before validating tool schemas.
Desktop Commander still uses Zod 3, which remains affected by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The input limit bounds collection validation work; dependency audits still report the underlying issue.

### Desktop Commander network requests

ThriftyRelay starts Desktop Commander with `DESKTOP_COMMANDER_DISABLE_TELEMETRY=1`, which turns off its usage telemetry.
Desktop Commander still downloads feature flags from `desktopcommander.app` at startup and periodically while it runs; that request is not controlled by the telemetry switch.

### Images and output

Image content is outside text redaction.
Screenshots and photos may contain secrets; read only intentionally exposed images.

Text redaction covers known patterns.
Review model output and third-party tools for secrets in other text or files.

### Process ownership

Process identity checks and termination are best-effort.
Ownership proof can fail because of:

- PID reuse
- Incomplete descendant evidence
- Unavailable or untrusted `ss` or `lsof` output

Failed ownership proof does not authorize terminating an unrelated process.

A missing PID can leave detached work running.
Cancellation and recovery preserve external effects that already occurred.
Do not retry an unknown write automatically.

### Scoped execution

Scoped leases and local recovery are implemented.
Live scoped concurrency rollout remains blocked until independent integration tests finish.

`expected_files` and cwd hashes provide review evidence.
They grant no admission and do not inventory all side effects.

### Windows process control

Use the guarded `mcp:restart` procedure for a live Windows host.
The basic lifecycle CLI omits some writer-lock protections.

The following need verification:

- Cleanup after closing the terminal
- Non-elevated control of a highest-run-level scheduled task

### Linux and macOS

POSIX background startup survives terminal exit; logout or reboot can stop it.
Setup installs no automatic startup unit, and ThriftyRelay refuses UID 0.

macOS Keychain and physical-Mac behavior need verification, including secret exposure through credential command arguments.

### Authentication and host checks

The Codex adapter requires file-backed ChatGPT authentication.
Keyring-only compatibility remains unresolved.

Check the following separately from offline tests and CI:

- The live MCP host
- MCP Apps rendering and approval interactions
- Real Codex approval flows

### Uninstall

Uninstall removes the recorded credential entry, configuration, launcher, logs, and runtime state.
Copies may remain in:

- Backups
- Process memory
- Separately named credential items

The task store, administrator-registered admission policy, and unrelated tools and credentials remain in place.

Linux Secret Service deletion is best-effort.
Uninstall stops if a matching item remains visible after `secret-tool clear`.
A locked-only item can look absent.

### Recovery records

Keep request tombstones, recovery evidence, and audit receipts together.
Do not delete locks or alter recovery records to bypass a refusal.
Use [guided recovery](docs/en/recovery.md) and preserve any partial-failure audit ID.
