import { Hono } from 'hono';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { getDatabase } from '../lib/database';
import { ValidationError, ConflictError } from '../lib/errors';
import { detectDefaultBranch } from '../services/git.service';

const app = new Hono();

app.get('/repos', (c) => {
  const db = getDatabase();
  const repos = db.prepare(`
    SELECT r.*,
           COUNT(CASE WHEN w.state = 'ready' THEN 1 END) as ready_count,
           COUNT(CASE WHEN w.state = 'archived' THEN 1 END) as archived_count,
           COUNT(w.id) as total_count
    FROM repos r
    LEFT JOIN workspaces w ON w.repository_id = r.id
    GROUP BY r.id
    ORDER BY r.display_order, r.created_at DESC
  `).all();
  return c.json(repos);
});

app.post('/repos', async (c) => {
  const db = getDatabase();
  let { root_path } = await c.req.json();
  if (!root_path) throw new ValidationError('root_path is required');

  // Normalize path
  try { root_path = fs.realpathSync(root_path); }
  catch { throw new ValidationError('Path does not exist or is inaccessible'); }

  // Verify permissions
  try { fs.accessSync(root_path, fs.constants.R_OK | fs.constants.X_OK); }
  catch (err: any) { return c.json({ error: 'Path is not accessible (permission denied)', details: err.code }, 403); }

  const stats = fs.statSync(root_path);
  if (!stats.isDirectory()) throw new ValidationError('Path is not a directory');

  // Check git repo
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root_path, timeout: 2000 }); }
  catch { throw new ValidationError('Path is not a git repository'); }

  const repoName = path.basename(root_path);
  const defaultBranch = detectDefaultBranch(root_path);

  const insertRepo = db.transaction((root_path: string, repoId: string, repoName: string, defaultBranch: string) => {
    const existing = db.prepare('SELECT * FROM repos WHERE root_path = ?').get(root_path);
    if (existing) throw new ConflictError('Repository already exists', existing);

    const maxOrder = db.prepare('SELECT MAX(display_order) as max FROM repos').get() as any;
    const displayOrder = (maxOrder?.max || 0) + 1;

    db.prepare(`
      INSERT INTO repos (id, name, root_path, default_branch, display_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(repoId, repoName, root_path, defaultBranch, displayOrder);

    return db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);
  });

  const repoId = randomUUID();
  const repo = insertRepo(root_path, repoId, repoName, defaultBranch);
  return c.json(repo, 201);
});

export default app;
