import path from "node:path";

export const DEUS_APP_ID = "com.deus.app";
export const DEUS_DB_FILENAME = "deus.db";
export const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
export const DATABASE_IN_USE = "Another Deus backend already owns the database.";
// A stuck turn can drain for 10s before the engine stops its remaining
// processes (SIGTERM, then SIGKILL after 3s). A parent and the next database
// owner must both give that shutdown time to finish.
export const BACKEND_SHUTDOWN_TIMEOUT_MS = 20_000;

export class DatabaseInUseError extends Error {
  constructor(filename: string) {
    super(`${DATABASE_IN_USE} ${filename}`);
  }
}

export interface RuntimePathOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  xdgDataHome?: string;
  devRoot?: string;
}

export interface RuntimeStagePaths {
  root: string;
  common: {
    root: string;
    backendBundle: string;
  };
  electron: {
    root: string;
  };
}

export function resolveDefaultDataDir(options: RuntimePathOptions): string {
  if (options.devRoot) return path.join(options.devRoot, ".deus-dev");

  if (options.platform === "darwin") {
    return path.posix.join(options.homeDir, "Library", "Application Support", DEUS_APP_ID);
  }

  return path.posix.join(
    options.xdgDataHome || path.posix.join(options.homeDir, ".local", "share"),
    "deus"
  );
}

export function resolveDefaultDatabasePath(options: RuntimePathOptions): string {
  return path.posix.join(resolveDefaultDataDir(options), DEUS_DB_FILENAME);
}

export function resolveRuntimeStagePaths(projectRoot: string): RuntimeStagePaths {
  const runtimeRoot = path.join(projectRoot, "dist", "runtime");
  const commonRoot = path.join(runtimeRoot, "common");
  const electronRoot = path.join(runtimeRoot, "electron");

  return {
    root: runtimeRoot,
    common: {
      root: commonRoot,
      backendBundle: path.join(commonRoot, "server.bundled.cjs"),
    },
    electron: {
      root: electronRoot,
    },
  };
}
