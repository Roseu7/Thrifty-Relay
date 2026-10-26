// The `platform` suite covers every platform adapter. Adapters that need a live process or
// a live service keep their own file; this entry point keeps it to one CI step.
await import("./test-platform-process.mjs");
await import("./test-platform-paths.mjs");
await import("./test-platform-secrets.mjs");
await import("./test-platform-policy.mjs");
await import("./test-platform-service.mjs");
await import("./test-platform-task.mjs");
await import("./test-uninstall.mjs");
await import("./test-runtime-posix.mjs");
await import("./test-runtime-state.mjs");
