// apps/backend/src/services/aap/registry.ts
// Load + cache installed-app manifests.
//
// v1 reads the hardcoded list in config/installed-apps.ts. Swap for a
// workspace-local scanner in v2 without touching apps.service.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

import { parseManifest, type Manifest } from "@shared/aap/manifest";
import { INSTALLED_APP_MANIFESTS } from "../../config/installed-apps";

/** Internal registry row — includes the parsed manifest plus the on-disk
 *  paths we need for spawning. Not a public view; see `shared/aap/types.ts`
 *  for the public-facing `InstalledApp` returned from `listApps()`. */
export interface InstalledAppEntry {
  manifest: Manifest;
  manifestPath: string;
  /** Directory containing the manifest — used as the fallback `cwd` for spawn. */
  packageRoot: string;
}

let cache: InstalledAppEntry[] | null = null;

export function loadInstalledApps(): InstalledAppEntry[] {
  if (cache) return cache;
  cache = INSTALLED_APP_MANIFESTS.map((manifestPath) => {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    const manifest = parseManifest(raw);
    const packageRoot = dirname(manifestPath);
    // Fail-fast on typo'd skill paths. The agent would otherwise hit a
    // nebulous "skill file not found" error deep in a tool call; catching
    // it at load time points the maintainer at the manifest directly.
    for (const rel of manifest.skills) {
      if (isAbsolute(rel)) {
        throw new Error(
          `aap: manifest ${manifest.id} declares absolute skill path "${rel}"; must be relative to the package root`
        );
      }
      const abs = resolvePath(packageRoot, rel);
      if (!existsSync(abs)) {
        throw new Error(
          `aap: manifest ${manifest.id} declares skill "${rel}" but ${abs} does not exist`
        );
      }
    }
    return { manifest, manifestPath, packageRoot };
  });
  return cache;
}

/** Read + concatenate every skill file declared in the manifest. Paths are
 *  resolved from the package root; `loadInstalledApps` already asserted
 *  their existence, so a missing file here would indicate tampering between
 *  load time and now — we throw rather than silently dropping content. */
export function readAppSkills(entry: InstalledAppEntry): string {
  const chunks: string[] = [];
  for (const rel of entry.manifest.skills) {
    const abs = resolvePath(entry.packageRoot, rel);
    const body = readFileSync(abs, "utf8");
    chunks.push(`# ${rel}\n\n${body.trimEnd()}`);
  }
  return chunks.join("\n\n---\n\n");
}

export function getInstalledApp(id: string): InstalledAppEntry | undefined {
  return loadInstalledApps().find((a) => a.manifest.id === id);
}

/**
 * Reset the module-level cache.
 *
 * @internal
 * Test-only. Production code must never call this — the cache is invalidated
 * on process restart, not at runtime. Callers outside of `*.test.ts` files
 * should be flagged in review.
 */
export function __clearRegistryCacheForTests(): void {
  cache = null;
}
