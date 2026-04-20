// apps/backend/src/services/aap/storage.ts
// Storage-dir management for agentic apps.
//
// Deus guarantees storage.workspace and storage.global directories exist
// before an app spawns, and appends storage.workspace's relative path to
// the workspace .gitignore when it lives inside the workspace tree.
//
// Pure I/O — no DB, no singletons. Callers pass already-substituted
// absolute paths.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export async function ensureStorageDirs(paths: {
  workspace?: string;
  global?: string;
}): Promise<void> {
  if (paths.workspace) await mkdir(paths.workspace, { recursive: true });
  if (paths.global) await mkdir(paths.global, { recursive: true });
}

/**
 * Append the storage dir (relative to the workspace root) to
 * `{workspacePath}/.gitignore` if not already present. Idempotent.
 *
 * No-op when `storagePath` resolves outside `workspacePath` — only
 * in-tree storage dirs need a gitignore entry.
 */
export async function injectGitignore(workspacePath: string, storagePath: string): Promise<void> {
  const rel = relative(workspacePath, storagePath);
  // Outside the workspace (escaping `..`) or absolute = nothing to ignore.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;

  // Normalize to forward slashes with a trailing slash — git's preferred form.
  const entryBare = rel.split(sep).join("/");
  const entry = entryBare.endsWith("/") ? entryBare : entryBare + "/";

  const gitignorePath = join(workspacePath, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch {
    /* new file */
  }

  const alreadyPresent = current
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === entry || line === entryBare);
  if (alreadyPresent) return;

  const needsLeadingNewline = current.length > 0 && !current.endsWith("\n");
  const appended = `${current}${needsLeadingNewline ? "\n" : ""}${entry}\n`;
  await writeFile(gitignorePath, appended, "utf8");
}
