delete process.env.CONTROL_PLANE_API_KEY;
delete process.env.OPENAI_ADMIN_KEY;
delete process.env.CONTROL_PLANE_TUNNEL_ID;
delete process.env.TUNNEL_CLIENT_PROFILE_DIR;

try {
  const [{ getConfigPath }, { readSetupConfig }] = await Promise.all([
    import("../src/i18n/index.mjs"),
    import("../src/config.mjs"),
  ]);
  const configFile = getConfigPath();
  const config = await readSetupConfig(configFile);
  if (typeof config.workspace !== "string" || typeof config.taskDirectory !== "string") {
    throw new Error("CONFIG_INCOMPLETE");
  }
  process.env.THRIFTYRELAY_CONFIG_PATH = configFile;
  process.env.THRIFTYRELAY_CODEX_WORKSPACE = config.workspace;
  process.env.THRIFTYRELAY_TASK_DIR = config.taskDirectory;
  await import("../src/server.mjs");
} catch {
  process.stderr.write("THRIFTYRELAY_RUNTIME_CONFIG_INVALID\n");
  process.exitCode = 1;
}
