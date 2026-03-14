import { Hono } from 'hono';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { uuidv7 } from '@shared/lib/uuid';
import { getErrorCode } from '@shared/lib/errors';
import { getDatabase } from '../lib/database';
import { ValidationError, ConflictError } from '../lib/errors';
import { parseBody } from '../lib/validate';
import { CreateRepoBody } from '../lib/schemas';
import { detectDefaultBranch } from '../services/git.service';
import { getAllRepositories, getRepositoryByRootPath, getRepositoryById, getMaxRepositorySortOrder } from '../db';
import { readManifest, getNormalizedTasks, writeManifest, detectManifestFromProject } from '../services/manifest.service';
import { OpenDevsManifestSchema } from '../lib/opendevs-manifest';
import { NotFoundError } from '../lib/errors';
import { invalidate } from '../services/query-engine';
import type { QueryResource } from '../../../shared/types/query-protocol';

const app = new Hono();

app.get('/repos', (c) => {
  const db = getDatabase();
  return c.json(getAllRepositories(db));
});

app.post('/repos', async (c) => {
  const db = getDatabase();
  let { root_path } = parseBody(CreateRepoBody, await c.req.json());

  // Normalize path
  try { root_path = fs.realpathSync(root_path); }
  catch { throw new ValidationError('Path does not exist or is inaccessible'); }

  // Verify permissions
  try { fs.accessSync(root_path, fs.constants.R_OK | fs.constants.X_OK); }
  catch (err: unknown) { return c.json({ error: 'Path is not accessible (permission denied)', details: getErrorCode(err) }, 403); }

  const stats = fs.statSync(root_path);
  if (!stats.isDirectory()) throw new ValidationError('Path is not a directory');

  // Check git repo
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root_path, timeout: 2000 }); }
  catch { throw new ValidationError('Path is not a git repository'); }

  const repoName = path.basename(root_path);
  const defaultBranch = detectDefaultBranch(root_path);

  const insertRepo = db.transaction((root_path: string, repoId: string, repoName: string, defaultBranch: string) => {
    const existing = getRepositoryByRootPath(db, root_path);
    if (existing) throw new ConflictError('Repository already exists', existing);

    const sortOrder = getMaxRepositorySortOrder(db) + 1;

    db.prepare(`
      INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(repoId, repoName, root_path, defaultBranch, sortOrder);

    return getRepositoryById(db, repoId);
  });

  const repoId = uuidv7();
  const repo = insertRepo(root_path, repoId, repoName, defaultBranch);
  invalidate(["stats"] as QueryResource[]);
  return c.json(repo, 201);
});

// ─── Manifest Endpoints (per-repo, settings UI) ─────────────

// Read manifest from repo root
app.get('/repos/:id/manifest', (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param('id'));
  if (!repo) throw new NotFoundError('Repository not found');

  const manifest = readManifest(repo.root_path);
  if (!manifest) return c.json({ manifest: null, tasks: [] });
  const tasks = getNormalizedTasks(manifest);
  return c.json({ manifest, tasks });
});

// Write manifest to repo root
app.post('/repos/:id/manifest', async (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param('id'));
  if (!repo) throw new NotFoundError('Repository not found');

  const body = await c.req.json();
  const parsed = OpenDevsManifestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid manifest', issues: parsed.error.issues }, 400);
  const success = writeManifest(repo.root_path, parsed.data);
  if (!success) return c.json({ error: 'Failed to write manifest' }, 500);
  return c.json({ success: true });
});

// Auto-detect manifest from project files (package.json, Cargo.toml, etc.)
app.get('/repos/:id/detect-manifest', (c) => {
  const db = getDatabase();
  const repo = getRepositoryById(db, c.req.param('id'));
  if (!repo) throw new NotFoundError('Repository not found');

  const manifest = detectManifestFromProject(repo.root_path, repo.name);
  return c.json({ manifest });
});

export default app;
