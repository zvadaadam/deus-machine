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
 * Compute the filesystem path for a workspace.
 * All workspaces live at {root_path}/.deus/{slug}.
 */
export function computeWorkspacePath(ws: {
  root_path?: string | null;
  slug?: string | null;
}): string {
  if (!ws.root_path) return "";
  if (!ws.slug) return "";
  return path.join(ws.root_path, ".deus", ws.slug);
}

/**
 * Middleware that loads a workspace by :id param from the database.
 * Sets c.set('workspace') and c.set('workspacePath') on the Hono context.
 * Throws NotFoundError if workspace not found.
 */
export const withWorkspace = createMiddleware(async (c, next) => {
  const id = c.req.param("id")!;
  const db = getDatabase();

  const workspace = getWorkspaceForMiddleware(db, id);

  if (!workspace || !workspace.root_path || !workspace.slug) {
    throw new NotFoundError("Workspace not found");
  }

  const workspacePath = computeWorkspacePath(workspace);

  c.set("workspace", workspace);
  c.set("workspacePath", workspacePath);

  await next();
});
