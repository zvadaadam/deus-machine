/** Backend settings withheld from the processes it starts. */
export const BACKEND_CHILD_ENV_DENYLIST = [
  "BUN_OPTIONS",
  "DATABASE_PATH",
  "DEUS_BACKEND_PORT",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_DATA_DIR",
  "DEUS_DEV_ROOT",
  "DEUS_NATIVE_MODULES",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "DEUS_RUNTIME_EXECUTABLE",
  "ELECTRON_RUN_AS_NODE",
  "NODE_ENV",
  "NODE_PATH",
  "PORT",
] as const;

export function createBackendChildEnv(
  overrides: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of BACKEND_CHILD_ENV_DENYLIST) {
    delete env[key];
  }
  return { ...env, ...overrides };
}
