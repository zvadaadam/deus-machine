import { delimiter, join } from "path";

const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export function configurePackagedMainRuntimeEnv(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!options.isPackaged) return;

  const env = options.env ?? process.env;
  env.DEUS_PACKAGED = "1";

  if (!options.resourcesPath) return;

  const bundledBinDir = join(options.resourcesPath, "bin");
  env.DEUS_RESOURCES_PATH = options.resourcesPath;
  env.DEUS_BUNDLED_BIN_DIR = bundledBinDir;

  if (options.platform === "darwin") {
    env.PATH = [bundledBinDir, ...PACKAGED_SYSTEM_PATHS].join(delimiter);
  }
}
