import { createMiddleware } from "hono/factory";
import path from "path";
import { getDatabase } from "../lib/database";
import { NotFoundError } from "../lib/errors";
import { getWorkspaceForMiddleware } from "../db";
import type { WorkspaceWithDetailsRow } from "../db";

export interface WorkspaceContext {
  workspace: WorkspaceWithDetailsRow;
  workspacePath: string;
}

/**
 * Compute the filesystem path for a LOCAL workspace.
 * Local worktrees live at {root_path}/.deus/{slug}; cloud workspaces have no
 * local path (empty string) — gate local-FS features on `kind` via
 * resolveWorkspaceTarget, not on this returning "".
 */
export function computeWorkspacePath(ws: {
  kind?: string | null;
  root_path?: string | null;
  slug?: string | null;
}): string {
  if (ws.kind === "cloud") return "";
  if (!ws.root_path) return "";
  if (!ws.slug) return "";
  return path.join(ws.root_path, ".deus", ws.slug);
}

/** Where a workspace's files live and how to reach them. */
export type WorkspaceTarget =
  | { kind: "local"; path: string }
  | { kind: "cloud"; providerWorkspaceId: string | null };

/**
 * Single source of truth for "where does this workspace live".
 * Local-FS features (git, files, watchers, PTY) require kind === "local";
 * cloud features route through the agnt provider ids.
 */
export function resolveWorkspaceTarget(ws: {
  kind?: string | null;
  root_path?: string | null;
  slug?: string | null;
  provider_workspace_id?: string | null;
}): WorkspaceTarget {
  if (ws.kind === "cloud") {
    return { kind: "cloud", providerWorkspaceId: ws.provider_workspace_id ?? null };
  }
  return { kind: "local", path: computeWorkspacePath(ws) };
}

/**
 * Middleware that loads a workspace by :id param from the database.
 * Sets c.set('workspace') and c.set('workspacePath') on the Hono context.
 * Throws NotFoundError if workspace not found. Cloud workspaces pass through
 * with an empty workspacePath — local-FS routes must guard on workspace.kind.
 */
export const withWorkspace = createMiddleware(async (c, next) => {
  const id = c.req.param("id")!;
  const db = getDatabase();

  const workspace = getWorkspaceForMiddleware(db, id);

  if (!workspace) {
    throw new NotFoundError("Workspace not found");
  }
  if (workspace.kind !== "cloud" && (!workspace.root_path || !workspace.slug)) {
    throw new NotFoundError("Workspace not found");
  }

  const workspacePath = computeWorkspacePath(workspace);

  c.set("workspace", workspace);
  c.set("workspacePath", workspacePath);

  await next();
});
