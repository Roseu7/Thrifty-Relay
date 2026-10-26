# Contributing to ThriftyRelay

[日本語](docs/ja/contributing.md) | English

Bug reports with reproduction steps, documentation fixes, regression tests, results from platforms we have not verified, and small code changes are all welcome.
ThriftyRelay is maintained by Roseu; use GitHub issues for problems and pull requests for changes.
Report security issues as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Before you start

Open an issue first for larger changes to behavior, dependencies, platform support, or security boundaries, so we can agree on the scope.
Small documentation fixes can go straight to a pull request.

Do not put keys, tunnel IDs, task records, session data, process environments, or personal data in issues, pull requests, or test fixtures.
Use fake values and an isolated task store.

## Development setup

Use Node.js 22 or later and npm:

~~~sh
npm ci
node scripts/check-syntax.mjs
~~~

The offline tests use fixtures, so you do not need a real Codex sign-in or task store.
Running ThriftyRelay itself needs the credentials and tools described in [setup](docs/en/setup.md); you do not need to run setup to work on documentation.

If ThriftyRelay is running from the checkout you are editing, a running server keeps the code it already loaded, while newly started workers load your changes.
Restart it as described in [operations](docs/en/operations.md#update-and-restart-cautions) after checking for running work.

## Choosing tests

Run the tests that cover the area you changed; you do not need the full suite for every edit.
The scripts are defined in [package.json](package.json).

| Area | Command |
| --- | --- |
| Syntax and locale parity | `node scripts/check-syntax.mjs` |
| Source hash covers every loaded module | `node tests/test-source-build.mjs` |
| CLI/setup/doctor/settings/uninstall | `npm run test:cli` |
| OS adapters | `npm run test:platform` |
| Codex adapter and model selection with fixtures | `npm run test:codex` |
| Execution guards | `npm run test:stability` |
| Relay integration with fixtures | `npm run test:relay` |
| Local MCP control and recovery safety | `npm run test:local-ops` |
| Offline usage/quota logic | `npm run test:usage`, `npm run test:quota` |
| Access controls | `npm run test:access` |
| Admission | `npm run test:admission` |
| Approval windows | `npm run test:approval` |
| Pending approvals | `npm run test:approval-pending` |
| Policy registration | `npm run test:policy-install` |
| Approval gate | `npm run test:approval-gate` |
| Decline | `npm run test:approval-decline` |
| Scratch | `npm run test:scratch` |
| Scoped lease/recovery fixtures | `node tests/test-scope-leases.mjs`, `node tests/test-scoped-recovery.mjs`, `node tests/test-scoped-adapter.mjs` |
| POSIX runtime/state | `node tests/test-runtime-posix.mjs`, `node tests/test-runtime-state.mjs` on POSIX |
| Linux runtime integration | `node tests/test-runtime-background.mjs`, `node tests/test-runtime-foreground.mjs`, `node tests/test-setup-posix.mjs` on Linux |
| Linux Secret Service | `npm run test:secret-service` with its isolated session bus/keyring prerequisites |

`npm test` runs the standard offline suite.
`npm run test:async` and `npm run test:code` currently need Windows PowerShell.
`npm run test:live` calls real models and uses your Codex limits, so it is never run by the other scripts or by CI; run it only when you mean to.

The [CI workflow](.github/workflows/ci.yml) runs on pushes and pull requests to `main`, and can also be started manually.
It uses Node.js 22 with read-only repository permissions and no credentials.

| Platform | Platform-specific checks |
| --- | --- |
| Windows 2025 | PowerShell-dependent suites. |
| Ubuntu | POSIX state/runtime, background/foreground, setup, and Secret Service integration. |
| macOS | POSIX state and runtime. |

CI runs without ChatGPT or a real model, so a passing run covers offline behavior only.
The tunnel and live Codex behavior still need a local check.

### Test artifacts and retention

The test runner writes to `.test-artifacts` by default, or to the absolute path in `THRIFTYRELAY_TEST_ROOT`.
It accepts an empty directory or one it created earlier, and refuses a directory with other contents.
Do not point it at a live task store, project data, Codex sessions, or shared caches.

| Limit | Environment variable | Default |
| --- | --- | --- |
| Size | `THRIFTY_TEST_MAX_BYTES` | 256 MiB |
| Age | `THRIFTY_TEST_MAX_AGE_HOURS` | 168 hours |

The runner checks these limits before and after a run; they do not cap writes during execution.
It deletes only successful payloads whose processes stopped, keeping a small record of each run.

The following remain regardless of age or size:

- Failed runs, linked areas, and areas with an active or unknown owner
- Active or maintenance locks and unfinished or unknown tasks
- Request tombstones, conversations, and audit records

`npm run test:sweep` removes eligible successful payloads under these rules.
Use the recovery procedure for execution locks.

## Documentation

Update the document that owns the topic and its translation.
Link from the [English index](docs/en/README.md) or [Japanese index](docs/ja/README.md) instead of repeating detailed instructions in READMEs.

| Content | English source | Japanese version |
| --- | --- | --- |
| Project overview | `README.md` | `docs/ja/README.md` |
| Topic guides | `docs/en/<topic>.md` | `docs/ja/<topic>.md` |
| Contributing | `CONTRIBUTING.md` | `docs/ja/contributing.md` |
| Security | `SECURITY.md` | `docs/ja/security.md` |
| Changelog | `CHANGELOG.md` | `docs/ja/changelog.md` |

Use matching filenames and a language switch for topic guides.
`docs/README.md` selects the language.
Add notable changes to both changelogs under an Unreleased heading until they are tagged.
The English index links directly to the root contribution, security, and third-party notices documents.

### Writing style

- Put the result or next action first, with a short reason if needed.
- Keep procedures short. Use numbered steps for sequences, bullets for long conditions, and tables for values or comparisons.
- Write for external users. Leave out work logs and instructions to coding agents.
- State each claim once. Avoid fixed counts that can change, stacked negatives, and repeated bold warnings.
- In Japanese, use one sentence per line; avoid em dashes, middle-dot lists, and parenthetical asides.
- Keep both languages aligned in meaning, conditions, and instructions.

Before submitting documentation:

1. Verify options, codes, paths, and defaults against the current source.
2. Check relative links and anchors after moving or renaming headings.
3. Run `node scripts/check-syntax.mjs` and `git diff --check`.

Documents are outside the server's source hash, so documentation edits need no restart and appear on the next read.
Changes to the files listed in `src/source-build.mjs` block `remote_task` requests other than read and search until restart, with `REMOTE_SOURCE_CHANGED_RESTART_REQUIRED`.

## Code

Keep one execution path, report failures explicitly, and keep changes focused.
Preserve request deduplication, retention of unknown outcomes, process identity checks, writing the audit record before releasing a lock, and credential scrubbing.
Tests should check behavior that matters to users and important failure boundaries, not the internal structure.
Avoid new dependencies and abstractions unless there is a concrete need, and check their licenses when you add or upgrade one.

After changing `ui/settings.mjs` or `ui/settings.html`, run `npm run build:settings-ui` to regenerate `src/mcp/settings-app.html`, and commit the result.
The generated file bundles dependency code, so also check [third-party notices](THIRD_PARTY_NOTICES.md).

## Pull requests

The pull request template contains this checklist, and the bug report form asks for the commit, platform, command, reproduction steps, and diagnostic code.

- Describe the problem and the resulting behavior, and keep the diff to that scope.
- Update the owning document, and both READMEs if what they say changes.
- List the checks you ran, on which platform, and anything you could not run.
- Mention files that changed unexpectedly or tests that failed.
- Keep secrets and live task-store records out of the diff and the description.
- Update [third-party notices](THIRD_PARTY_NOTICES.md) when dependencies change.

## License

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).
Dependencies keep their own licenses.
