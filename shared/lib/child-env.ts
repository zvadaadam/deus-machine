import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveDefaultDatabasePath } from "../runtime";

/** Proxy clients can prefer either spelling, so both must describe the same bypass. */
export function mergeProxyExclusions(
  env: NodeJS.ProcessEnv,
  ...lists: (string | undefined)[]
): void {
  const hosts = new Set(
    [env.NO_PROXY, env.no_proxy, ...lists]
      .join(",")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean)
  );
  if (hosts.size) env.NO_PROXY = env.no_proxy = hosts.has("*") ? "*" : [...hosts].join(",");
}

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

/** Older installed versions passed their own runtime settings to agent shells. */
export function clearInheritedPackagedEnv(env: NodeJS.ProcessEnv, cwd = process.cwd()): void {
  if (env.DEUS_PACKAGED !== "1") return;
  const filename = env.DATABASE_PATH && (env.DATABASE_PATH.trim() || ":memory:");
  clearBackendChildEnv(env);
  if (!filename) return;
  const database = filename === ":memory:" ? filename : resolve(cwd, filename);
  if (database === resolve(defaultDatabasePathForEnv(env)))
    console.warn("Dropped inherited DATABASE_PATH because it matches the installed database path.");
  else env.DATABASE_PATH = database;
}
