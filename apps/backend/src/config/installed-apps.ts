// apps/backend/src/config/installed-apps.ts
// Hardcoded list of installed agentic apps for v1.
//
// Repo root is located via `resolveRepoRoot`, which walks up from this
// file looking for the monorepo's `package.json`. Works regardless of
// `process.cwd()` (Electron, bundled .app, test harness, etc.).
//
// v2 will replace this with a scanner that reads
// `{workspace}/.deus/apps/*.json` alongside this baked-in list.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "../lib/repo-root";

const REPO_ROOT =
  process.env.DEUS_REPO_ROOT ?? resolveRepoRoot(dirname(fileURLToPath(import.meta.url)));

export const INSTALLED_APP_MANIFESTS: readonly string[] = [
  resolve(REPO_ROOT, "packages/device-use/agentic-app.json"),
];
