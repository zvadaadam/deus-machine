import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import type BetterSqlite3 from 'better-sqlite3';
import { OpenDevsManifestSchema, type OpenDevsManifest, type NormalizedTask } from '../lib/opendevs-manifest';
import { emitProgress } from './workspace-init.service';

/**
 * Read and normalize opendevs.json manifests.
 *
 * Follows the config.service.ts pattern: readFileSync -> JSON.parse -> safeParse -> null on error.
 * Never throws — callers check for null.
 */

export function readManifest(dirPath: string): OpenDevsManifest | null {
  try {
    const manifestPath = path.join(dirPath, 'opendevs.json');
    if (!fs.existsSync(manifestPath)) return null;

    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const parsed = OpenDevsManifestSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('[MANIFEST] Invalid opendevs.json:', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.error('[MANIFEST] Error reading opendevs.json:', error);
    return null;
  }
}

/** lifecycle.setup takes precedence over legacy scripts.setup */
export function getSetupCommand(manifest: OpenDevsManifest): string | null {
  return manifest.lifecycle?.setup ?? manifest.scripts?.setup ?? null;
}

/** lifecycle.archive takes precedence over legacy scripts.archive */
export function getArchiveCommand(manifest: OpenDevsManifest): string | null {
  return manifest.lifecycle?.archive ?? manifest.scripts?.archive ?? null;
}

/** Normalize task entries: string shorthand → full object form */
export function getNormalizedTasks(manifest: OpenDevsManifest): NormalizedTask[] {
  if (!manifest.tasks) return [];

  return Object.entries(manifest.tasks).map(([name, entry]) => {
    if (typeof entry === 'string') {
      return {
        name,
        command: entry,
        description: null,
        icon: 'terminal',
        persistent: false,
        mode: 'concurrent' as const,
        depends: [],
        env: {},
      };
    }
    return {
      name,
      command: entry.command,
      description: entry.description ?? null,
      icon: entry.icon ?? 'terminal',
      persistent: entry.persistent ?? false,
      mode: entry.mode ?? 'concurrent',
      depends: entry.depends ?? [],
      env: entry.env ?? {},
    };
  });
}

/** Build environment variables for script execution */
export function getHiveEnv(
  manifest: OpenDevsManifest,
  ctx: { id: string; rootPath: string; workspacePath: string },
): Record<string, string> {
  return {
    ...(manifest.env ?? {}),
    OPENDEVS_ROOT_PATH: ctx.rootPath,
    OPENDEVS_WORKSPACE_PATH: ctx.workspacePath,
    OPENDEVS_WORKSPACE_ID: ctx.id,
  };
}

/**
 * Read manifest with repo-root fallback.
 * Workspace worktrees may not have opendevs.json if it was added after creation.
 * Checks the worktree first (agent may have modified it), then falls back to repo root.
 */
export function readManifestWithFallback(workspacePath: string, repoRootPath: string): OpenDevsManifest | null {
  return readManifest(workspacePath) ?? readManifest(repoRootPath);
}

/** Write a manifest object to opendevs.json */
export function writeManifest(dirPath: string, manifest: OpenDevsManifest): boolean {
  try {
    const manifestPath = path.join(dirPath, 'opendevs.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return true;
  } catch (error) {
    console.error('[MANIFEST] Error writing opendevs.json:', error);
    return false;
  }
}

export function runSetupScript(
  db: BetterSqlite3.Database,
  workspaceId: string,
  setupCmd: string,
  setupEnv: Record<string, string>,
  workspacePath: string,
): void {
  const setupLogPath = path.join(os.tmpdir(), `opendevs-${workspaceId}-setup.log`);
  const setupLog = fs.createWriteStream(setupLogPath);

  const setupProc = spawn('sh', ['-c', setupCmd], {
    cwd: workspacePath,
    env: { ...process.env, ...setupEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  setupProc.stdout.pipe(setupLog);
  setupProc.stderr.pipe(setupLog);

  const timer = setTimeout(() => {
    setupProc.kill('SIGTERM');
    setTimeout(() => { try { setupProc.kill('SIGKILL'); } catch {} }, 5000);
  }, 5 * 60 * 1000);

  let finished = false;
  const finish = (status: 'completed' | 'failed', error?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { setupLog.end(); } catch {}
    if (status === 'completed') {
      db.prepare("UPDATE workspaces SET setup_status = 'completed', error_message = NULL, updated_at = datetime('now') WHERE id = ?").run(workspaceId);
    } else {
      db.prepare("UPDATE workspaces SET setup_status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?").run(error, workspaceId);
    }
    // Emit progress event so frontend clears diff caches and re-fetches clean data.
    // Uses the same OPENDEVS_WORKSPACE_PROGRESS protocol that initializeWorkspace() uses
    // (Rust backend.rs parses the prefix → Tauri event → useWorkspaceInitEvents hook).
    const step = status === 'completed' ? 'setup_done' : 'setup_failed';
    const label = status === 'completed' ? 'Setup complete' : `Setup failed: ${error ?? 'unknown'}`;
    emitProgress(workspaceId, step, label);
  };

  setupProc.on('close', (code) => {
    if (code === 0) finish('completed');
    else finish('failed', `Setup exited with code ${code}`);
  });

  setupProc.on('error', (err) => {
    finish('failed', `Setup spawn error: ${err.message}`);
  });
}
