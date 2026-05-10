// apps/backend/src/config/installed-apps.ts
// Hardcoded list of installed agentic apps for v1.
//
// Repo root is located via `resolveRepoRoot`, which walks up from the backend
// cwd looking for the monorepo's `package.json`. Packaged apps read manifests
// from Electron extraResources instead.
//
// v2 will replace this with a scanner that reads
// `{workspace}/.deus/apps/*.json` alongside this baked-in list.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRepoRoot } from "../lib/repo-root";

function uniqueExisting(paths: Array<string | null>): string[] {
  const seen = new Set<string>();
  const existing: string[] = [];

  for (const path of paths) {
    if (!path || seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    existing.push(path);
  }

  return existing;
}

function resolveDevManifest(packagePath: string): string | null {
  try {
    const root = process.env.DEUS_REPO_ROOT ?? resolveRepoRoot(process.cwd());
    return resolve(root, packagePath);
  } catch {
    return null;
  }
}

function resolvePackagedManifest(relPath: string): string | null {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;
  return resolve(resourcesPath, relPath);
}

export const INSTALLED_APP_MANIFESTS: readonly string[] = uniqueExisting([
  resolvePackagedManifest("agentic-apps/device-use/agentic-app.json"),
  resolveDevManifest("packages/device-use/agentic-app.json"),
  resolvePackagedManifest("agentic-apps/pencil/agentic-app.json"),
  resolveDevManifest("packages/pencil/agentic-app.json"),
]);
