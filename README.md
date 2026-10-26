# ThriftyRelay

ThriftyRelay is a local MCP server that lets ChatGPT hand coding work to Codex on your own machine.
Codex uses your ChatGPT sign-in and your plan's Codex limits, without separate API billing.

[日本語](docs/ja/README.md) | English

[Documentation](docs/en/README.md)

ThriftyRelay is maintained by Roseu and is not affiliated with OpenAI.
The npm package is not published; install it from a clone as shown below.
Before 1.0, a minor release may include breaking changes; check the [changelog](CHANGELOG.md) before updating.

- Checks five-hour and weekly limits before each new request. By default, ChatGPT asks for approval when either remaining limit falls to or below its threshold.
- Records Codex request IDs. An unchanged resend returns the original task.
- Retains unknown write outcomes for review and recovery.

## How it works

1. ChatGPT plans the work and calls ThriftyRelay's MCP tools through an OpenAI tunnel.
2. `tunnel-client` on your machine passes each call to the local ThriftyRelay server.
3. ThriftyRelay checks admission, and the quota limits for Codex work, then runs the step: Codex for coding work, or a direct file read or command.
4. ThriftyRelay records the request and returns the changed files and command output.
5. ChatGPT reviews that evidence and decides whether the work is done.

## Requirements

- Node.js 22 or later, npm, and Git
- A Codex CLI sign-in with a ChatGPT account
- An OpenAI tunnel ID, a tunnel API key for that tunnel, and a `tunnel-client` executable
- Linux: `secret-tool` with a Secret Service session and `ss`
- macOS: the login Keychain and `lsof`

[Setup](docs/en/setup.md) covers where to get each item and how to choose a workspace.
[Platform status](docs/en/setup.md#platform-status) shows what has been tested on each system.

## Quick start

### Install

~~~sh
git clone https://github.com/Roseu7/Thrifty-Relay.git
cd Thrifty-Relay
npm ci
npm install -g .
~~~

`npm install -g .` links the `thriftyrelay` command to this clone, so keep the clone where it is.
npm may warn that the `thrifty-relay` install script was not allowed; `npm ci` has already run it.

Run setup from the directory you want Codex to work in; setup offers it as the workspace.

### Windows

~~~powershell
thriftyrelay setup
~~~

On an existing Windows installation, setup can stop and replace the running task, so check for running work first as described in [operations](docs/en/operations.md#update-and-restart-cautions).

### Linux and macOS

~~~sh
thriftyrelay setup
thriftyrelay start
~~~

Linux and macOS setup saves the configuration and does not start anything; `start` runs it in the background, and `thriftyrelay stop` stops it.
[Setup](docs/en/setup.md) explains the startup modes and what setup verifies.

### Connect ChatGPT

Keep ThriftyRelay running, then add it to ChatGPT on the web:

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, then **Add custom MCP server**.
2. Enter `ThriftyRelay` as the name.
3. Under **Connection**, select **Tunnel** and choose your tunnel, then select **No authentication**.
4. Confirm the risk warning, select **Create as a plugin**, and install the plugin.

[Setup](docs/en/setup.md#chatgpt-connection) covers each step, plan and workspace permissions, and what to check if the tunnel does not appear.

## Try it

Start a new conversation, type `@`, select `ThriftyRelay`, and ask it to call `health`.
A healthy reply looks like this:

~~~text
ThriftyRelay <version>: OK; Windows; file/shell tools available (26 internal tools); build=<build>; source=current; codex=target-configured; writers=coordinated; scratch=configured; enforcement=unregistered
~~~

| Response | Meaning or next step |
| --- | --- |
| Starts with `ThriftyRelay <version>: OK` | ChatGPT reached the server. |
| `codex=target-configured` | A Codex workspace is configured. Try the small task below to check execution. |
| `codex=disabled` | Configure a Codex workspace with setup. |
| `source=changed-restart-required` | Source files changed after startup. Follow the [restart procedure](docs/en/operations.md#update-and-restart-cautions) before sending work. |

Then give Codex a small task that does not change anything, for example: ask Codex to list the files in the workspace and explain what the project does.

> [!WARNING]
> Without a registered [admission policy](docs/en/admission.md), Codex uses `danger-full-access` under the account running ThriftyRelay.
> The policy selects the Codex worker's sandbox.

Working-directory and write-scope checks control request admission; the worker sandbox controls filesystem access.
If a write ends with an unknown outcome, follow [recovery](docs/en/recovery.md) instead of resending it.

## Skills

The startup catalog lists global Codex Skills from `~/.codex/skills`.
See [Skills](docs/en/skills.md) for selection, disabling entries with `enabled = false`, and handling their contents as untrusted data within the existing permissions.

## Documentation

| Goal | Guide |
| --- | --- |
| Install and connect | [Setup](docs/en/setup.md) |
| Start, stop, update, or uninstall | [Operations](docs/en/operations.md) |
| Choose models and quota actions | [Settings](docs/en/settings.md) |
| Submit and review Codex work | [Delegation](docs/en/orchestration.md) |
| Use global Skills | [Skills](docs/en/skills.md) |
| Configure access and write scopes | [Admission](docs/en/admission.md) |
| Investigate an unknown execution | [Recovery](docs/en/recovery.md) |
| Understand implementation and contribute | [Documentation index](docs/en/README.md) |

## Development

`npm ci`, `node scripts/check-syntax.mjs`, and `npm test` run the offline checks.
[CONTRIBUTING.md](CONTRIBUTING.md) lists the per-area test commands.

## Contributing

Bug reports, documentation fixes, and focused changes are welcome.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), and see [CHANGELOG.md](CHANGELOG.md) for changes.

## License

[MIT License](LICENSE).
Dependency licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
