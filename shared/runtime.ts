import path from "node:path";

export const DEUS_APP_ID = "com.deus.app";
export const DEUS_DB_FILENAME = "deus.db";
export const DEUS_PREFERENCES_FILENAME = "preferences.json";
export const RUNTIME_MANIFEST_VERSION = 1;
export const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

export interface RuntimePathOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  xdgDataHome?: string;
}

export interface RuntimeStagePaths {
  root: string;
  manifest: string;
  common: {
    root: string;
    backendBundle: string;
  };
  electron: {
    root: string;
  };
}

export function resolveDefaultDataDir(options: RuntimePathOptions): string {
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
    manifest: path.join(runtimeRoot, "manifest.json"),
    common: {
      root: commonRoot,
      backendBundle: path.join(commonRoot, "server.bundled.cjs"),
    },
    electron: {
      root: electronRoot,
    },
  };
}
