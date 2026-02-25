/**
 * Workspace Initialization Pipeline
 *
 * Orchestrates the multi-step process of creating a workspace:
 *   1. git worktree add (fatal — cleanup on failure)
 *   2. Dependency installation via lockfile-detected PM (non-fatal)
 *   3. Post-create hooks: .env / .env.local copy (non-fatal)
 *   4. Git clean: restore tracked files so diff starts at zero (non-fatal)
 *   5. Session creation + state transition to 'ready' (fatal)
 *
 * Each step updates the workspace's `init_stage` column in DB and emits
 * a structured stdout line that Rust parses and relays as a Tauri event:
 *   HIVE_WORKSPACE_PROGRESS:{"workspaceId":"...","step":"...","label":"..."}
 *
 * Design decisions:
 * - Pipeline runs in-process (async), not as spawned child — proper try/catch
 * - Non-fatal steps (deps, hooks) log warnings but don't block workspace creation
 * - Reverse-order cleanup on fatal failure: rm dir → prune worktree → delete branch
 * - Aligns with OpenDevs's approach (structured init pipeline with deps install)
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { uuidv7 } from '@shared/lib/uuid';
import { getDatabase } from '../lib/database';

const execFileAsync = promisify(execFile);

/** Check if an error is a retryable SQLite concurrency error (BUSY / locked). */
export function isRetryableDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('sqlite_busy') || msg.includes('database is locked') || msg.includes('database is busy');
}

// ─── Types ──────────────────────────────────────────────────────

export interface InitContext {
  workspaceId: string;
  repositoryId: string;
  repoRootPath: string;
  workspacePath: string;
  branchName: string;
  worktreeBase: string;
  parentBranch: string;
}

interface InitStage {
  name: string;
  label: string;
  fatal: boolean;
  run: (ctx: InitContext) => Promise<void>;
  cleanup?: (ctx: InitContext) => Promise<void>;
}

// ─── Progress Emission ──────────────────────────────────────────

/**
 * Emit workspace init progress via stdout JSON protocol.
 * Rust's backend.rs reads stdout line-by-line and relays lines
 * prefixed with HIVE_WORKSPACE_PROGRESS: as Tauri events.
 */
export function emitProgress(workspaceId: string, step: string, label: string): void {
  const payload = JSON.stringify({ workspaceId, step, label });
  process.stdout.write(`HIVE_WORKSPACE_PROGRESS:${payload}\n`);
}

function updateInitStage(workspaceId: string, stage: string): void {
  const db = getDatabase();
  db.prepare('UPDATE workspaces SET init_stage = ? WHERE id = ?').run(stage, workspaceId);
}

// ─── Package Manager Detection ──────────────────────────────────

interface PackageManager {
  command: string;
  args: string[];
}

/**
 * Detect the package manager from lockfile presence in the workspace.
 * Returns null if no package.json exists (nothing to install).
 */
export function detectPackageManager(dir: string): PackageManager | null {
  // Check lockfiles in priority order (bun first — project default)
  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) {
    return { command: 'bun', args: ['install', '--frozen-lockfile'] };
  }
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) {
    return { command: 'yarn', args: ['install', '--frozen-lockfile'] };
  }
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) {
    return { command: 'pnpm', args: ['install', '--frozen-lockfile'] };
  }
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) {
    return { command: 'npm', args: ['ci'] };
  }
  // package.json exists but no lockfile — try npm install
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    return { command: 'npm', args: ['install'] };
  }
  return null;
}

// ─── Cleanup ────────────────────────────────────────────────────

async function cleanupWorktree(
  repoRootPath: string,
  workspacePath: string,
  branchName: string,
): Promise<void> {
  // Remove worktree directory
  try {
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[WORKSPACE] Failed to remove worktree directory:', e);
  }

  // Prune git worktree references
  try {
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: repoRootPath,
      timeout: 5_000,
    });
  } catch (e) {
    console.warn('[WORKSPACE] Failed to prune worktrees:', e);
  }

  // Delete the orphaned branch
  try {
    await execFileAsync('git', ['branch', '-D', branchName], {
      cwd: repoRootPath,
      timeout: 5_000,
    });
  } catch {
    // Branch may not have been created — that's fine
  }
}

// ─── Pipeline Stages ────────────────────────────────────────────

const STAGES: InitStage[] = [
  {
    name: 'worktree',
    label: 'Creating worktree...',
    fatal: true,
    async run(ctx) {
      await execFileAsync('git', [
        'worktree', 'add', '-b', ctx.branchName, ctx.workspacePath, ctx.worktreeBase,
      ], { cwd: ctx.repoRootPath, timeout: 30_000 });
    },
    async cleanup(ctx) {
      await cleanupWorktree(ctx.repoRootPath, ctx.workspacePath, ctx.branchName);
    },
  },
  {
    name: 'dependencies',
    label: 'Installing dependencies...',
    fatal: false,
    async run(ctx) {
      const pm = detectPackageManager(ctx.workspacePath);
      if (!pm) {
        console.log('[WORKSPACE] No package.json found, skipping dependency install');
        return;
      }
      console.log(`[WORKSPACE] Installing dependencies with ${pm.command}...`);
      await execFileAsync(pm.command, pm.args, {
        cwd: ctx.workspacePath,
        timeout: 120_000, // 2 min max for large installs
        env: { ...process.env, CI: '1' }, // Suppress interactive prompts
      });
    },
  },
  {
    name: 'hooks',
    label: 'Setting up environment...',
    fatal: false,
    async run(ctx) {
      // Copy .env from repo root if it exists and worktree doesn't have one
      const envFiles = ['.env', '.env.local'];
      for (const envFile of envFiles) {
        const src = path.join(ctx.repoRootPath, envFile);
        const dst = path.join(ctx.workspacePath, envFile);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          try {
            fs.copyFileSync(src, dst);
            console.log(`[WORKSPACE] Copied ${envFile} to worktree`);
          } catch (e) {
            console.warn(`[WORKSPACE] Failed to copy ${envFile}:`, e);
          }
        }
      }
    },
  },
  {
    name: 'git-clean',
    label: 'Verifying workspace...',
    fatal: false,
    async run(ctx) {
      // After deps install and .env copy, the working directory may have
      // tracked-file modifications (e.g., lockfile normalization by the
      // package manager, generated build cache files). Reset tracked files
      // to match the index so the diff pipeline sees zero changes on a
      // fresh workspace branched from origin/main.
      await execFileAsync('git', ['checkout', '--', '.'], {
        cwd: ctx.workspacePath,
        timeout: 10_000,
      });
    },
  },
  {
    name: 'session',
    label: 'Finalizing...',
    fatal: true,
    async run(ctx) {
      // Retry with exponential backoff to handle SQLITE_BUSY / database-locked
      // errors that can occur when the sidecar is concurrently accessing the DB.
      const db = getDatabase();
      const sessionId = uuidv7();
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const finalize = db.transaction(() => {
            db.prepare(
              "INSERT INTO sessions (id, workspace_id, status, updated_at) VALUES (?, ?, 'idle', datetime('now'))"
            ).run(sessionId, ctx.workspaceId);
            db.prepare(
              "UPDATE workspaces SET state = 'ready', current_session_id = ?, init_stage = 'done' WHERE id = ?"
            ).run(sessionId, ctx.workspaceId);
          });
          finalize();
          return;
        } catch (err) {
          if (attempt < maxAttempts && isRetryableDbError(err)) {
            const delay = Math.pow(2, attempt) * 100; // 200ms, 400ms
            console.warn(
              `[WORKSPACE] Session creation attempt ${attempt}/${maxAttempts} failed (${(err as Error).message}), retrying in ${delay}ms...`
            );
            await new Promise((r) => setTimeout(r, delay));
          } else {
            throw err;
          }
        }
      }
    },
  },
];

// ─── Pipeline Runner ────────────────────────────────────────────

export async function initializeWorkspace(ctx: InitContext): Promise<void> {
  const completed: InitStage[] = [];

  for (const stage of STAGES) {
    try {
      updateInitStage(ctx.workspaceId, stage.name);
    } catch (err) {
      // SQLITE_BUSY can fire when sidecar holds the DB — log but don't
      // abort, otherwise cleanup never runs and worktrees leak.
      console.warn('[WORKSPACE] Failed to update init_stage:', err);
    }
    emitProgress(ctx.workspaceId, stage.name, stage.label);

    try {
      await stage.run(ctx);
      completed.push(stage);
    } catch (err) {
      console.error(`[WORKSPACE] Stage "${stage.name}" failed:`, err);

      if (stage.fatal) {
        // Reverse-order cleanup of completed stages
        for (const done of [...completed].reverse()) {
          if (done.cleanup) {
            await done.cleanup(ctx).catch((e) =>
              console.warn(`[WORKSPACE] Cleanup for "${done.name}" failed:`, e)
            );
          }
        }

        const db = getDatabase();
        db.prepare(
          "UPDATE workspaces SET state = 'error', init_stage = ?, error_message = ? WHERE id = ?"
        ).run(stage.name, (err as Error).message, ctx.workspaceId);

        emitProgress(ctx.workspaceId, 'error', `Failed at: ${stage.name}`);
        return;
      }
      // Non-fatal: log and continue to next stage
      console.warn(`[WORKSPACE] Non-fatal stage "${stage.name}" failed, continuing...`);
    }
  }

  emitProgress(ctx.workspaceId, 'done', 'Ready');
}
