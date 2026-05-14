const BACKEND_CHILD_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "BUN_OPTIONS",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BACKEND_PORT",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_DATA_DIR",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "ELECTRON_RUN_AS_NODE",
  "NODE_PATH",
  "PORT",
] as const;

export function createBackendChildEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of BACKEND_CHILD_ENV_DENYLIST) {
    delete env[key];
  }
  return { ...env, ...overrides };
}
