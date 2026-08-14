// packages/agent-ports/src/git-root.ts
// Resolve a session cwd to its git MAIN repository root using fs only (no git
// spawn): worktrees carry a `.git` FILE with `gitdir: <main>/.git/worktrees/<n>`
// — the main root is the project the user actually thinks in terms of
// (Conductor/Codex worktrees live outside the repo root, so substring matching
// against registered repositories can never find them).

import { promises as fsp } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const cache = new Map<string, string | undefined>();

export async function resolveGitMainRoot(startCwd: string): Promise<string | undefined> {
  if (!startCwd) return undefined;
  const cached = cache.get(startCwd);
  if (cached !== undefined || cache.has(startCwd)) return cached;

  let result: string | undefined;
  let dir = startCwd;
  // Walk up (sessions often run in subdirectories); missing dirs just walk on.
  for (let depth = 0; depth < 10; depth++) {
    const dotGit = join(dir, ".git");
    try {
      const stat = await fsp.stat(dotGit);
      if (stat.isDirectory()) {
        result = dir; // a main checkout root itself
        break;
      }
      if (stat.isFile()) {
        const text = await fsp.readFile(dotGit, "utf8");
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
        if (match) {
          let gitdir = match[1];
          if (!isAbsolute(gitdir)) gitdir = resolve(dir, gitdir);
          const normalized = gitdir.replace(/\\/g, "/");
          const worktreeIdx = normalized.indexOf("/.git/worktrees/");
          if (worktreeIdx !== -1) result = normalized.slice(0, worktreeIdx);
          else if (normalized.endsWith("/.git")) result = normalized.slice(0, -"/.git".length);
          else result = dirname(normalized);
        }
        break;
      }
    } catch {
      /* no .git here — walk up */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(startCwd, result);
  return result;
}
