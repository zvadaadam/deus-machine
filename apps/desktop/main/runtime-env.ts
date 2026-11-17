import { delimiter, join } from "path";
import { BACKEND_CHILD_ENV_DENYLIST } from "../../../shared/lib/child-env";
import { PACKAGED_SYSTEM_PATHS } from "../../../shared/runtime";

// Named for the packaging check (scripts/runtime/electron-builder-before-pack.cjs).
export const PACKAGED_RUNTIME_ENV_DENYLIST = BACKEND_CHILD_ENV_DENYLIST;

export function configurePackagedMainRuntimeEnv(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!options.isPackaged) return;

  const env = options.env ?? process.env;
  for (const key of PACKAGED_RUNTIME_ENV_DENYLIST) {
    delete env[key];
  }
  env.DEUS_PACKAGED = "1";

  if (!options.resourcesPath) return;

  const bundledBinDir = join(options.resourcesPath, "bin");
  env.NODE_ENV = "production";
  env.DEUS_RESOURCES_PATH = options.resourcesPath;
  env.DEUS_BUNDLED_BIN_DIR = bundledBinDir;

  if (options.platform === "darwin" || options.platform === "linux") {
    env.PATH = [bundledBinDir, ...PACKAGED_SYSTEM_PATHS].join(delimiter);
  }
}
