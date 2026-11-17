import path from "node:path";

export const DEUS_APP_ID = "com.deus.app";
export const DEUS_DB_FILENAME = "deus.db";
export const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

export interface RuntimePathOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  appData?: string;
  xdgDataHome?: string;
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

function getPathModule(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveDefaultDataDir(options: RuntimePathOptions): string {
  const targetPath = getPathModule(options.platform);

  if (options.platform === "darwin") {
    return targetPath.join(options.homeDir, "Library", "Application Support", DEUS_APP_ID);
  }

  if (options.platform === "win32") {
    return targetPath.join(
      options.appData || targetPath.join(options.homeDir, "AppData", "Roaming"),
      DEUS_APP_ID
    );
  }

  return targetPath.join(
    options.xdgDataHome || targetPath.join(options.homeDir, ".local", "share"),
    "deus"
  );
}

export function resolveDefaultDatabasePath(options: RuntimePathOptions): string {
  return getPathModule(options.platform).join(resolveDefaultDataDir(options), DEUS_DB_FILENAME);
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
