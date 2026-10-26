# ThriftyRelay development

This Git checkout is the development source.
A normal development clone has no live MCP process; use the offline checks for changes.
If this checkout is also the live MCP entrypoint, runtime changes on disk may affect newly spawned workers, and an already running MCP requires a guarded restart to load changes.
Keep the repository runnable during development.

- Limit changes to requested repository files. If this checkout is the live entrypoint, do not restart the live MCP or modify its Windows launcher, tunnel, credentials, persistent task store, or recovery records unless explicitly requested.
- Review the current diff before editing. Preserve existing changes and report any unexpected files or side effects.
- Run focused checks for the changed code. Never run `test:live` or launch real-model inference unless the task explicitly calls for it.
- Do not commit, push, switch branches, or modify global configuration unless explicitly requested.
- Keep changes small. Do not add extra agents, automatic reviews by the upper model, or new dependencies without a concrete need.
