import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_RUNTIME_DEPENDENCIES,
  DEUS_APP_ID,
  DEUS_DB_FILENAME,
  DEUS_PREFERENCES_FILENAME,
  RUNTIME_MANIFEST_VERSION,
  resolveRuntimeStagePaths,
} from "../../shared/runtime";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(runtimeDir, "../..");

export interface StageRuntimeOptions {
  log?: (line: string) => void;
  projectRoot?: string;
}

export interface RuntimeManifest {
  version: number;
  appId: string;
  data: {
    databaseFile: string;
    preferencesFile: string;
  };
  bundles: {
    common: {
      backend: string;
      agentServer: string;
    };
    electron: {
      backend: string;
      agentServer: string;
    };
  };
  nodeRuntimeDependencies: readonly string[];
}

function relativeFromProjectRoot(projectRoot: string, targetPath: string): string {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

function assertCliRuntimeDependencies(projectRoot: string, log: (line: string) => void): void {
  const cliPackagePath = path.join(projectRoot, "apps", "cli", "package.json");
  const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const declared = new Set(Object.keys(cliPackage.dependencies ?? {}));
  const missing = CLI_RUNTIME_DEPENDENCIES.filter((dependency) => !declared.has(dependency));

  if (missing.length > 0) {
    throw new Error(`apps/cli/package.json is missing runtime dependencies: ${missing.join(", ")}`);
  }

  log(`✓ CLI runtime dependencies declared (${CLI_RUNTIME_DEPENDENCIES.length})`);
}

export function stageRuntime(options: StageRuntimeOptions = {}): RuntimeManifest {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const stagePaths = resolveRuntimeStagePaths(projectRoot);
  const sources = {
    backendBundle: path.join(projectRoot, "apps", "backend", "dist", "server.bundled.cjs"),
    agentServerBundle: path.join(projectRoot, "apps", "agent-server", "dist", "index.bundled.cjs"),
  };

  for (const [label, sourcePath] of Object.entries(sources)) {
    if (!existsSync(sourcePath)) {
      throw new Error(`Missing ${label}: ${sourcePath}`);
    }
  }

  assertCliRuntimeDependencies(projectRoot, log);

  rmSync(stagePaths.root, { recursive: true, force: true });

  mkdirSync(path.dirname(stagePaths.common.backendBundle), { recursive: true });
  mkdirSync(path.dirname(stagePaths.common.agentServerBundle), { recursive: true });
  mkdirSync(path.dirname(stagePaths.electron.backendBundle), { recursive: true });
  mkdirSync(path.dirname(stagePaths.electron.agentServerBundle), { recursive: true });

  cpSync(sources.backendBundle, stagePaths.common.backendBundle);
  cpSync(sources.agentServerBundle, stagePaths.common.agentServerBundle);
  cpSync(sources.backendBundle, stagePaths.electron.backendBundle);
  cpSync(sources.agentServerBundle, stagePaths.electron.agentServerBundle);

  const manifest: RuntimeManifest = {
    version: RUNTIME_MANIFEST_VERSION,
    appId: DEUS_APP_ID,
    data: {
      databaseFile: DEUS_DB_FILENAME,
      preferencesFile: DEUS_PREFERENCES_FILENAME,
    },
    bundles: {
      common: {
        backend: relativeFromProjectRoot(projectRoot, stagePaths.common.backendBundle),
        agentServer: relativeFromProjectRoot(projectRoot, stagePaths.common.agentServerBundle),
      },
      electron: {
        backend: relativeFromProjectRoot(projectRoot, stagePaths.electron.backendBundle),
        agentServer: relativeFromProjectRoot(projectRoot, stagePaths.electron.agentServerBundle),
      },
    },
    nodeRuntimeDependencies: CLI_RUNTIME_DEPENDENCIES,
  };

  writeFileSync(stagePaths.manifest, JSON.stringify(manifest, null, 2) + "\n");
  log(`✓ Runtime staged at ${relativeFromProjectRoot(projectRoot, stagePaths.root)}`);
  return manifest;
}
