import { Hono } from 'hono';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { getDatabase } from '../lib/database';
import { ValidationError, ConflictError } from '../lib/errors';
import { parseBody } from '../lib/validate';
import { CreateRepoBody } from '../lib/schemas';
import { detectDefaultBranch } from '../services/git.service';
import { getAllRepos, getRepoByRootPath, getRepoById, getMaxRepoDisplayOrder } from '../db';

const app = new Hono();

app.get('/repos', (c) => {
  const db = getDatabase();
  return c.json(getAllRepos(db));
});

app.post('/repos', async (c) => {
  const db = getDatabase();
  let { root_path } = parseBody(CreateRepoBody, await c.req.json());

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
    const existing = getRepoByRootPath(db, root_path);
    if (existing) throw new ConflictError('Repository already exists', existing);

    const displayOrder = getMaxRepoDisplayOrder(db) + 1;

    db.prepare(`
      INSERT INTO repos (id, name, root_path, default_branch, display_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(repoId, repoName, root_path, defaultBranch, displayOrder);

    return getRepoById(db, repoId);
  });

  const repoId = randomUUID();
  const repo = insertRepo(root_path, repoId, repoName, defaultBranch);
  return c.json(repo, 201);
});

export default app;
