import { createMiddleware } from 'hono/factory';
import path from 'path';
import os from 'os';
import { getDatabase } from '../lib/database';
import { NotFoundError } from '../lib/errors';

export interface WorkspaceContext {
  workspace: any;
  workspacePath: string;
}

/**
 * Compute the filesystem path for a workspace based on storage version.
 * - storage_version 3 (legacy): ~/conductor/workspaces/{repo_name}/{directory_name}
 * - storage_version 2 (current): {root_path}/.conductor/{directory_name}
 */
export function computeWorkspacePath(ws: {
  root_path?: string | null;
  directory_name?: string | null;
  storage_version?: number;
  repo_name?: string | null;
}): string {
  if (!ws.root_path || !ws.directory_name) return '';
  if (ws.storage_version === 3 && ws.repo_name) {
    return path.join(os.homedir(), 'conductor', 'workspaces', ws.repo_name, ws.directory_name);
  }
  return path.join(ws.root_path, '.conductor', ws.directory_name);
}

/**
 * Middleware that loads a workspace by :id param from the database.
 * Sets c.set('workspace') and c.set('workspacePath') on the Hono context.
 * Throws NotFoundError if workspace not found.
 */
export const withWorkspace = createMiddleware(async (c, next) => {
  const id = c.req.param('id');
  const db = getDatabase();

  const workspace = db.prepare(`
    SELECT w.*, r.root_path, r.default_branch, r.storage_version, r.name as repo_name
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    WHERE w.id = ?
  `).get(id) as any;

  if (!workspace || !workspace.root_path || !workspace.directory_name) {
    throw new NotFoundError('Workspace not found');
  }

  const workspacePath = computeWorkspacePath(workspace);

  c.set('workspace', workspace);
  c.set('workspacePath', workspacePath);

  await next();
});
