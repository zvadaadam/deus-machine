/** Create the checkout, prepare its environment, then make the session available. */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../lib/database";
import { prepareLocalEnvironment } from "./project-environment.service";
import { invalidate } from "./query-engine";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

export interface InitContext {
  workspaceId: string;
  repositoryId: string;
  repoRootPath: string;
  workspacePath: string;
  branchName: string;
  worktreeBase: string;
  parentBranch: string;
  repoOriginUrl?: string | null;
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
 * Electron's backend-process.ts reads stdout line-by-line and relays lines
 * prefixed with DEUS_WORKSPACE_PROGRESS: as IPC events.
 */
export function emitProgress(workspaceId: string, step: string, label: string): void {
  const payload = JSON.stringify({ workspaceId, step, label });
  process.stdout.write(`DEUS_WORKSPACE_PROGRESS:${payload}\n`);
}

function updateInitStage(workspaceId: string, stage: string): void {
  const db = getDatabase();
  db.prepare("UPDATE workspaces SET init_stage = ? WHERE id = ?").run(stage, workspaceId);
}

// ─── Cleanup ────────────────────────────────────────────────────

async function cleanupWorktree(
  repoRootPath: string,
  workspacePath: string,
  branchName: string
): Promise<void> {
  // Remove worktree directory
  try {
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn("[WORKSPACE] Failed to remove worktree directory:", e);
  }

  // Prune git worktree references
  try {
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: repoRootPath,
      timeout: 5_000,
    });
  } catch (e) {
    console.warn("[WORKSPACE] Failed to prune worktrees:", e);
  }

  // Delete the orphaned branch
  try {
    await execFileAsync("git", ["branch", "-D", branchName], {
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
    name: "worktree",
    label: "Creating worktree...",
    fatal: true,
    async run(ctx) {
      await execFileAsync(
        "git",
        ["worktree", "add", "-b", ctx.branchName, ctx.workspacePath, ctx.worktreeBase],
        { cwd: ctx.repoRootPath, timeout: 30_000 }
      );
    },
    async cleanup(ctx) {
      await cleanupWorktree(ctx.repoRootPath, ctx.workspacePath, ctx.branchName);
    },
  },
  {
    name: "hooks",
    label: "Setting up environment...",
    fatal: false,
    async run(ctx) {
      // Copy .env from repo root if it exists and worktree doesn't have one
      const envFiles = [".env", ".env.local"];
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
    name: "setup",
    label: "Running setup…",
    fatal: false,
    async run(ctx) {
      await prepareLocalEnvironment(ctx.workspaceId, ctx.workspacePath, ctx.repoOriginUrl);
    },
  },
  {
    name: "session",
    label: "Preparing workspace...",
    fatal: true,
    async run(ctx) {
      // Setup has finished or reported its error; the agent can now work or repair it.
      const db = getDatabase();
      const sessionId = uuidv7();

      db.transaction(() => {
        db.prepare(
          "INSERT INTO sessions (id, workspace_id, status, updated_at) VALUES (?, ?, 'idle', datetime('now'))"
        ).run(sessionId, ctx.workspaceId);
        db.prepare(
          "UPDATE workspaces SET state = 'ready', current_session_id = ? WHERE id = ?"
        ).run(sessionId, ctx.workspaceId);
      })();

      // Push state change immediately so frontend picks up session + ready state
      invalidate(["workspaces", "stats", "sessions"]);
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
      // SQLITE_BUSY can fire when concurrent backend operations hold the DB — log but don't
      // abort, otherwise cleanup never runs and worktrees leak.
      console.warn("[WORKSPACE] Failed to update init_stage:", err);
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
            await done
              .cleanup(ctx)
              .catch((e) => console.warn(`[WORKSPACE] Cleanup for "${done.name}" failed:`, e));
          }
        }

        const db = getDatabase();
        db.prepare(
          "UPDATE workspaces SET state = 'error', init_stage = ?, error_message = ? WHERE id = ?"
        ).run(stage.name, (err as Error).message, ctx.workspaceId);

        emitProgress(ctx.workspaceId, "error", `Failed at: ${stage.name}`);

        // Workspace transitioned to 'error' — notify connected clients.
        invalidate(["workspaces", "stats"]);
        return;
      }
      // Non-fatal: log and continue to next stage
      console.warn(`[WORKSPACE] Non-fatal stage "${stage.name}" failed, continuing...`);
    }
  }

  // Mark preparation complete. A failed setup remains visible and can be retried.
  // Wrapped in try/catch so a DB lock can't block final progress signaling.
  try {
    updateInitStage(ctx.workspaceId, "done");
  } catch (err) {
    console.warn(`[WORKSPACE] Failed to update init_stage to done for ${ctx.workspaceId}:`, err);
  }
  emitProgress(ctx.workspaceId, "done", "Ready");

  // Background stages finished — push final state to all connected clients.
  invalidate(["workspaces", "stats"]);
}
