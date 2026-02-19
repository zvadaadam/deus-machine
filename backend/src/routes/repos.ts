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
import { readManifest, getNormalizedTasks, writeManifest } from '../services/manifest.service';
import { HiveManifestSchema } from '../lib/hive-manifest';
import { NotFoundError } from '../lib/errors';

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

// ─── Manifest Endpoints (per-repo, settings UI) ─────────────

// Read manifest from repo root
app.get('/repos/:id/manifest', (c) => {
  const db = getDatabase();
  const repo = getRepoById(db, c.req.param('id'));
  if (!repo) throw new NotFoundError('Repository not found');

  const manifest = readManifest(repo.root_path);
  if (!manifest) return c.json({ manifest: null, tasks: [] });
  const tasks = getNormalizedTasks(manifest);
  return c.json({ manifest, tasks });
});

// Write manifest to repo root
app.post('/repos/:id/manifest', async (c) => {
  const db = getDatabase();
  const repo = getRepoById(db, c.req.param('id'));
  if (!repo) throw new NotFoundError('Repository not found');

  const body = await c.req.json();
  const parsed = HiveManifestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid manifest', issues: parsed.error.issues }, 400);
  const success = writeManifest(repo.root_path, parsed.data);
  if (!success) return c.json({ error: 'Failed to write manifest' }, 500);
  return c.json({ success: true });
});

// Auto-detect manifest from project files (package.json, Cargo.toml, etc.)
app.get('/repos/:id/detect-manifest', (c) => {
  const db = getDatabase();
  const repo = getRepoById(db, c.req.param('id'));
  if (!repo) throw new NotFoundError('Repository not found');

  const manifest = detectManifestFromProject(repo.root_path, repo.name);
  return c.json({ manifest });
});

/**
 * Scan a project directory and generate a suggested hive.json manifest.
 * Reads package.json, Cargo.toml, Makefile, etc. to infer scripts and tasks.
 */
function detectManifestFromProject(rootPath: string, repoName: string): Record<string, unknown> {
  const manifest: Record<string, unknown> = { version: 1, name: repoName };
  const tasks: Record<string, unknown> = {};
  const requires: Record<string, string> = {};

  // Detect Node.js / Bun project
  const pkgJsonPath = path.join(rootPath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const pm = fs.existsSync(path.join(rootPath, 'bun.lock')) ? 'bun' :
                 fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml')) ? 'pnpm' :
                 fs.existsSync(path.join(rootPath, 'yarn.lock')) ? 'yarn' : 'npm';
      const run = pm === 'npm' ? 'npm run' : `${pm} run`;

      requires[pm] = '>= 1.0';
      if (pm !== 'bun') requires.node = '>= 18';

      manifest.scripts = { setup: `${pm} install` };
      manifest.lifecycle = { setup: `${pm} install` };

      const scripts = pkg.scripts || {};
      if (scripts.dev) tasks.dev = { command: `${run} dev`, description: 'Start dev server', icon: 'play', persistent: true };
      if (scripts.build) tasks.build = { command: `${run} build`, description: 'Build for production', icon: 'hammer' };
      if (scripts.test) tasks.test = { command: `${run} test`, description: 'Run tests', icon: 'check-circle' };
      if (scripts.lint) tasks.lint = { command: `${run} lint`, description: 'Lint code', icon: 'search-code' };
      if (scripts.format) tasks.format = { command: `${run} format`, description: 'Format code', icon: 'paintbrush' };
      if (scripts.typecheck) tasks.typecheck = { command: `${run} typecheck`, description: 'Type check', icon: 'search-code' };
      if (scripts.start) tasks.start = { command: `${run} start`, description: 'Start production server', icon: 'rocket', persistent: true };
    } catch { /* invalid package.json — skip */ }
  }

  // Detect Rust project
  const cargoPath = path.join(rootPath, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    requires.cargo = '>= 1.0';
    if (!manifest.scripts) manifest.scripts = { setup: 'cargo build' };
    if (!manifest.lifecycle) manifest.lifecycle = { setup: 'cargo build' };
    if (!tasks.build) tasks.build = { command: 'cargo build --release', description: 'Build release', icon: 'hammer' };
    if (!tasks.test) tasks.test = { command: 'cargo test', description: 'Run tests', icon: 'check-circle' };
    tasks.clippy = { command: 'cargo clippy', description: 'Lint with Clippy', icon: 'search-code' };
  }

  // Detect Python project
  const pyprojectPath = path.join(rootPath, 'pyproject.toml');
  const requirementsPath = path.join(rootPath, 'requirements.txt');
  if (fs.existsSync(pyprojectPath) || fs.existsSync(requirementsPath)) {
    requires.python = '>= 3.10';
    const hasUv = fs.existsSync(path.join(rootPath, 'uv.lock'));
    const pip = hasUv ? 'uv pip' : 'pip';
    if (!manifest.scripts) manifest.scripts = { setup: fs.existsSync(requirementsPath) ? `${pip} install -r requirements.txt` : `${pip} install -e .` };
    if (!manifest.lifecycle) manifest.lifecycle = { setup: fs.existsSync(requirementsPath) ? `${pip} install -r requirements.txt` : `${pip} install -e .` };
    if (!tasks.test) tasks.test = { command: 'pytest', description: 'Run tests', icon: 'check-circle' };
  }

  // Detect Makefile
  const makefilePath = path.join(rootPath, 'Makefile');
  if (fs.existsSync(makefilePath)) {
    try {
      const content = fs.readFileSync(makefilePath, 'utf-8');
      const targets = content.match(/^([a-zA-Z_-]+)\s*:/gm);
      if (targets) {
        for (const match of targets.slice(0, 8)) { // Cap at 8 tasks
          const target = match.replace(':', '').trim();
          if (['all', '.PHONY', '.DEFAULT'].includes(target)) continue;
          if (tasks[target]) continue; // Don't overwrite more specific detections
          tasks[target] = `make ${target}`;
        }
      }
    } catch { /* unreadable Makefile — skip */ }
  }

  if (Object.keys(requires).length > 0) manifest.requires = requires;
  if (Object.keys(tasks).length > 0) manifest.tasks = tasks;

  return manifest;
}

export default app;
