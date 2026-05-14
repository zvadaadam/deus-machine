import { delimiter, join } from "path";

const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
export const PACKAGED_RUNTIME_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "BUN_OPTIONS",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_BACKEND_PORT",
  "DEUS_DATA_DIR",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "ELECTRON_RUN_AS_NODE",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "NODE_PATH",
  "PORT",
] as const;

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

  if (options.platform === "darwin") {
    env.PATH = [bundledBinDir, ...PACKAGED_SYSTEM_PATHS].join(delimiter);
  }
}
