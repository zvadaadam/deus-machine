import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, sep } from "node:path";
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

function resolveDatabaseFile(filename: string, cwd: string): string {
  const absolute = isAbsolute(filename) ? filename : `${cwd}${sep}${filename}`;
  let target = parse(absolute).root;
  // Follow each existing directory before interpreting "..", even for a new database.
  for (const part of absolute.slice(target.length).split(sep)) {
    target = join(target, part);
    if (existsSync(target)) target = realpathSync.native(target);
  }
  return target;
}

export function prepareDevBackendEnv(env: NodeJS.ProcessEnv, backendCwd: string): void {
  const override = env.DATABASE_PATH;
  const legacyShell = env.DEUS_PACKAGED === "1";
  if (legacyShell) clearBackendChildEnv(env);
  if (!override) return;

  const filename = override.trim();
  const database =
    filename && filename !== ":memory:" ? resolveDatabaseFile(filename, backendCwd) : ":memory:";
  if (legacyShell && database === resolveDatabaseFile(defaultDatabasePathForEnv(env), backendCwd)) {
    return;
  }
  if (database !== database.trimEnd()) {
    throw new Error(`Cannot use "${database}" because its filename ends in whitespace.`);
  }
  env.DATABASE_PATH = database;
}

/** Older installed versions passed their own runtime settings to agent shells. */
export function clearInheritedPackagedEnv(env: NodeJS.ProcessEnv): void {
  if (env.DEUS_PACKAGED === "1") prepareDevBackendEnv(env, process.cwd());
}
