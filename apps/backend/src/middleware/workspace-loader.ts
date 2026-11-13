import { createMiddleware } from "hono/factory";
import path from "path";
import { getDatabase } from "../lib/database";
import { NotFoundError } from "../lib/errors";
import { getWorkspaceForMiddleware, type WorkspaceWithDetailsRow } from "../db";

/**
 * Compute the filesystem path for a LOCAL workspace.
 * Local worktrees live at {root_path}/.deus/{slug}; cloud workspaces have no
 * local path (empty string) — gate local-FS features on the owning node
 * (services/node: `workspaceNodeId` / `resolveNode`), not on this returning "".
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

/**
 * A workspace and where its files are on this computer ("" for a cloud
 * workspace: gate local-file features on the owning node, not on the path).
 * Throws NotFoundError when there is no such workspace.
 */
export function loadWorkspace(id: string): {
  workspace: WorkspaceWithDetailsRow;
  workspacePath: string;
} {
  const workspace = getWorkspaceForMiddleware(getDatabase(), id);
  if (!workspace) throw new NotFoundError("Workspace not found");
  if (workspace.kind !== "cloud" && (!workspace.root_path || !workspace.slug)) {
    throw new NotFoundError("Workspace not found");
  }
  return { workspace, workspacePath: computeWorkspacePath(workspace) };
}

/** HTTP form of `loadWorkspace`: sets `workspace` and `workspacePath` from the `:id` param. */
export const withWorkspace = createMiddleware(async (c, next) => {
  const { workspace, workspacePath } = loadWorkspace(c.req.param("id")!);
  c.set("workspace", workspace);
  c.set("workspacePath", workspacePath);
  await next();
});
