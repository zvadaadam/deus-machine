import { createMiddleware } from 'hono/factory';
import path from 'path';
import { getDatabase } from '../lib/database';
import { NotFoundError } from '../lib/errors';

export interface WorkspaceContext {
  workspace: any;
  workspacePath: string;
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
    SELECT w.*, r.root_path, r.default_branch
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    WHERE w.id = ?
  `).get(id) as any;

  if (!workspace || !workspace.root_path || !workspace.directory_name) {
    throw new NotFoundError('Workspace not found');
  }

  const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);

  c.set('workspace', workspace);
  c.set('workspacePath', workspacePath);

  await next();
});
