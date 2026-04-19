// apps/backend/src/lib/repo-root.ts
//
// Single source of truth for "where is the Deus monorepo root?" at runtime.
// Walks up from a starting directory looking for the repo's root
// `package.json` (identified by `"name": "deus"`). Used by any backend
// code that needs to locate sibling packages without depending on
// `process.cwd()` (which is unreliable when the backend is spawned by
// Electron or a packaged .app).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO_PACKAGE_NAME = "deus";

/**
 * Walk up from `startDir` until a `package.json` with the repo's canonical
 * name is found. Throws if we hit the filesystem root without a match.
 *
 * Callers should pass their module's own directory (via
 * `dirname(fileURLToPath(import.meta.url))`) so the walk anchors to their
 * source location, not `process.cwd()`.
 */
export function resolveRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    const pjPath = join(dir, "package.json");
    if (existsSync(pjPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pjPath, "utf8")) as { name?: unknown };
        if (pkg.name === REPO_PACKAGE_NAME) return dir;
      } catch {
        // Unparseable package.json — keep walking; a malformed file higher
        // in the tree shouldn't stop us finding a valid one further up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `resolveRepoRoot: no "${REPO_PACKAGE_NAME}" package.json found above ${startDir}`
      );
    }
    dir = parent;
  }
}
