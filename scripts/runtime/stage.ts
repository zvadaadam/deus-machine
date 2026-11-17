import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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
  preserveElectron?: boolean;
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
    };
  };
}

function relativeFromProjectRoot(projectRoot: string, targetPath: string): string {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

export function stageRuntime(options: StageRuntimeOptions = {}): RuntimeManifest {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const stagePaths = resolveRuntimeStagePaths(projectRoot);
  const sources = {
    backendBundle: path.join(projectRoot, "apps", "backend", "dist", "server.bundled.cjs"),
  };

  for (const [label, sourcePath] of Object.entries(sources)) {
    if (!existsSync(sourcePath)) {
      throw new Error(`Missing ${label}: ${sourcePath}`);
    }
  }

  if (options.preserveElectron === true) {
    rmSync(stagePaths.common.root, { recursive: true, force: true });
    rmSync(stagePaths.manifest, { force: true });
  } else {
    rmSync(stagePaths.root, { recursive: true, force: true });
  }

  mkdirSync(path.dirname(stagePaths.common.backendBundle), { recursive: true });

  cpSync(sources.backendBundle, stagePaths.common.backendBundle);

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
      },
    },
  };

  writeFileSync(stagePaths.manifest, JSON.stringify(manifest, null, 2) + "\n");
  log(`✓ Runtime staged at ${relativeFromProjectRoot(projectRoot, stagePaths.root)}`);
  return manifest;
}
