// packages/agent-ports/src/match.ts
// Project detection: map a session's cwd onto what Deus already knows.
// Pure functions — the backend service supplies repos/workspaces from the DB.

import type { PortableSessionHead } from "./types";

export interface KnownRepo {
  id: string;
  name: string;
  rootPath: string;
}

export interface KnownWorkspace {
  id: string;
  repositoryId: string;
  /** Absolute worktree path ({repo.rootPath}/.deus/{slug}). */
  path: string;
  title?: string;
}

export type ProjectMatch =
  | { kind: "workspace"; repositoryId: string; workspaceId: string; projectName: string }
  | { kind: "repository"; repositoryId: string; projectName: string }
  | { kind: "unknown"; projectName: string };

function normalize(p: string): string {
  // Windows cwds/roots arrive with backslashes and arbitrary drive-letter
  // casing; fold both so containment checks work cross-platform.
  let out = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out;
}

function isWithin(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * Match a cwd to a Deus workspace (worktree), else a repository (longest
 * rootPath wins so nested repos resolve to the deepest match), else unknown
 * (project name = cwd basename).
 */
export function matchCwd(
  rawCwd: string,
  repos: KnownRepo[],
  workspaces: KnownWorkspace[]
): ProjectMatch {
  const cwd = normalize(rawCwd);
  if (!cwd) return { kind: "unknown", projectName: "Unknown project" };

  let workspaceHit: KnownWorkspace | undefined;
  for (const workspace of workspaces) {
    const path = normalize(workspace.path);
    if (!path) continue;
    if (isWithin(cwd, path) && (!workspaceHit || path.length > normalize(workspaceHit.path).length))
      workspaceHit = workspace;
  }
  if (workspaceHit) {
    const repo = repos.find((r) => r.id === workspaceHit!.repositoryId);
    return {
      kind: "workspace",
      repositoryId: workspaceHit.repositoryId,
      workspaceId: workspaceHit.id,
      projectName: repo?.name ?? basename(cwd),
    };
  }

  let repoHit: KnownRepo | undefined;
  for (const repo of repos) {
    const root = normalize(repo.rootPath);
    if (!root) continue;
    if (isWithin(cwd, root) && (!repoHit || root.length > normalize(repoHit.rootPath).length))
      repoHit = repo;
  }
  if (repoHit) return { kind: "repository", repositoryId: repoHit.id, projectName: repoHit.name };

  return { kind: "unknown", projectName: basename(cwd) };
}

function basename(p: string): string {
  const clean = normalize(p);
  const name = clean.split("/").at(-1);
  return name && name.length > 0 ? name : clean || "Unknown project";
}

/**
 * Sessions Deus itself produced (already in deus.db) — hide by default so the
 * import list only shows foreign history:
 * - Codex rollouts stamped originator agent-server / deus-machine.
 * - Any session whose cwd is inside a Deus worktree ({repo}/.deus/…).
 */
export function isDeusOwned(head: PortableSessionHead, workspaces: KnownWorkspace[]): boolean {
  if (head.identity.provider === "codex") {
    const originator = head.extra?.originator;
    if (originator === "agent-server" || originator === "deus-machine") return true;
  }
  const cwd = normalize(head.identity.cwd);
  if (cwd.includes("/.deus/")) return true;
  return workspaces.some((w) => normalize(w.path) && isWithin(cwd, normalize(w.path)));
}
