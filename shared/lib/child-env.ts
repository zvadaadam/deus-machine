import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveDefaultDatabasePath } from "../runtime";

/** Backend settings withheld from the processes it starts. */
const BACKEND_CHILD_ENV_DENYLIST = [
  "BUN_OPTIONS",
  "DATABASE_PATH",
  "DEUS_BACKEND_PORT",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_DATA_DIR",
  "DEUS_NATIVE_MODULES",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "DEUS_RUNTIME_EXECUTABLE",
  "ELECTRON_RUN_AS_NODE",
  "NODE_ENV",
  "NODE_PATH",
  "PORT",
] as const;

export function clearBackendChildEnv(env: NodeJS.ProcessEnv): void {
  for (const key of BACKEND_CHILD_ENV_DENYLIST) delete env[key];
}

export function createBackendChildEnv(
  overrides: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  clearBackendChildEnv(env);
  return { ...env, ...overrides };
}

export function defaultDatabasePathForEnv(env: NodeJS.ProcessEnv, devRoot?: string): string {
  return resolveDefaultDatabasePath({
    platform: process.platform,
    homeDir: env.HOME || homedir(),
    xdgDataHome: env.XDG_DATA_HOME,
    devRoot,
  });
}

function sameDatabaseFile(candidate: string, installed: string): boolean {
  if (!candidate || candidate === ":memory:") return false;
  try {
    return realpathSync.native(candidate) === realpathSync.native(installed);
  } catch {
    return resolve(candidate) === resolve(installed); // One or both files do not exist yet.
  }
}

/** Older installed versions passed their own runtime settings to agent shells. */
export function clearInheritedPackagedEnv(env: NodeJS.ProcessEnv): void {
  if (env.DEUS_PACKAGED !== "1") return;
  const installed = defaultDatabasePathForEnv(env);
  const override = env.DATABASE_PATH;
  clearBackendChildEnv(env);
  if (override !== undefined && !sameDatabaseFile(override.trim(), installed)) {
    env.DATABASE_PATH = override;
  }
}
