/** Create the checkout, prepare its environment, then make the session available. */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { getRepositoryById, getWorkspaceRaw } from "../db";
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
  /** Project operations reserve the initial conversation before preparing files. */
  sessionId?: string;
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
      if (ctx.sessionId && fs.existsSync(ctx.workspacePath)) {
        // A retry may follow a crash after git completed but before SQL did.
        // Never adopt an unrelated directory or reset its changes.
        const [workspaceRoot, branch, commonDir, repoCommonDir] = await Promise.all([
          execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.workspacePath }),
          execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: ctx.workspacePath }),
          execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: ctx.workspacePath }),
          execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: ctx.repoRootPath }),
        ]);
        if (
          fs.realpathSync(workspaceRoot.stdout.trim()) !== fs.realpathSync(ctx.workspacePath) ||
          branch.stdout.trim() !== ctx.branchName ||
          fs.realpathSync(path.resolve(ctx.workspacePath, commonDir.stdout.trim())) !==
            fs.realpathSync(path.resolve(ctx.repoRootPath, repoCommonDir.stdout.trim()))
        ) {
          throw new ConflictError(
            "The reserved Project workspace path belongs to another checkout."
          );
        }
        return;
      }
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
      if (ctx.sessionId) {
        const workspace = getDatabase()
          .prepare("SELECT setup_status FROM workspaces WHERE id = ?")
          .get(ctx.workspaceId) as { setup_status: string };
        // Setup commands may have external effects. Completed/failed preparation
        // is not rerun because a later session transaction needs a retry.
        if (workspace.setup_status === "completed" || workspace.setup_status === "failed") return;
        if (workspace.setup_status === "running") {
          throw new ConflictError("Workspace setup was interrupted. Review setup before retrying.");
        }
      }
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
      const sessionId = ctx.sessionId ?? uuidv7();

      db.transaction(() => {
        const existing = db
          .prepare("SELECT workspace_id FROM sessions WHERE id = ?")
          .get(sessionId) as { workspace_id: string } | undefined;
        const workspace = db
          .prepare("SELECT current_session_id FROM workspaces WHERE id = ?")
          .get(ctx.workspaceId) as { current_session_id: string | null } | undefined;
        if (!workspace) throw new NotFoundError("Workspace was removed during preparation.");
        if (existing && existing.workspace_id !== ctx.workspaceId) {
          throw new ConflictError("Reserved conversation belongs to another workspace.");
        }
        if (
          ctx.sessionId &&
          workspace.current_session_id &&
          workspace.current_session_id !== sessionId
        ) {
          throw new ConflictError("Project workspace already has another current conversation.");
        }
        if (!existing) {
          db.prepare(
            "INSERT INTO sessions (id, workspace_id, status, updated_at) VALUES (?, ?, 'idle', datetime('now'))"
          ).run(sessionId, ctx.workspaceId);
        }
        db.prepare(
          `UPDATE workspaces SET state = 'ready', current_session_id = ?,
            error_message = CASE WHEN setup_status = 'failed' THEN error_message ELSE NULL END
            WHERE id = ?`
        ).run(sessionId, ctx.workspaceId);
      })();

      // Push state change immediately so frontend picks up session + ready state
      invalidate(["workspaces", "stats", "sessions"]);
    },
  },
];

// ─── Pipeline Runner ────────────────────────────────────────────

async function runInitialization(ctx: InitContext): Promise<void> {
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

      if (stage.fatal || (ctx.sessionId && stage.name === "setup")) {
        // Reverse-order cleanup of completed stages
        for (const done of ctx.sessionId ? [] : [...completed].reverse()) {
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

const preparing = new Map<string, { request: string; promise: Promise<void> }>();

export function initializeWorkspace(ctx: InitContext): Promise<void> {
  if (!ctx.sessionId) return runInitialization(ctx);
  const request = JSON.stringify(ctx);
  const pending = preparing.get(ctx.workspaceId);
  if (pending) {
    if (pending.request !== request) {
      return Promise.reject(new ConflictError("Workspace preparation is already in progress."));
    }
    return pending.promise;
  }
  const promise = runInitialization(ctx).finally(() => preparing.delete(ctx.workspaceId));
  preparing.set(ctx.workspaceId, { request, promise });
  return promise;
}

/** Resolve once before reserving a Project operation; retries use the saved commit. */
export async function resolveProjectBaseCommit(repositoryId: string, sourceBranch?: string) {
  const repository = getRepositoryById(getDatabase(), repositoryId);
  if (!repository) throw new NotFoundError("Repository not found");
  const branch = sourceBranch ?? repository.git_default_branch;
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`],
    { cwd: repository.root_path, timeout: 5_000 }
  );
  return { baseCommit: stdout.trim(), sourceBranch: branch };
}

/** Prepare a shell already reserved atomically with Project membership and work. */
export async function prepareProjectWorkspace(input: {
  workspaceId: string;
  sessionId: string;
  repositoryId: string;
  baseCommit: string;
  sourceBranch?: string;
}): Promise<{ workspaceId: string; sessionId: string; workspacePath: string }> {
  const db = getDatabase();
  const workspace = getWorkspaceRaw(db, input.workspaceId);
  const repository = getRepositoryById(db, input.repositoryId);
  if (!workspace || !repository)
    throw new NotFoundError("Reserved workspace or repository not found");
  if (
    workspace.kind !== "worktree" ||
    workspace.repository_id !== input.repositoryId ||
    !workspace.git_branch
  ) {
    throw new ValidationError("Projects require a reserved local repository workspace.");
  }
  if (workspace.state === "archived") throw new ConflictError("Project workspace is archived.");
  const workspacePath = path.join(repository.root_path, ".deus", workspace.slug);
  if (workspace.state === "ready") {
    if (workspace.current_session_id !== input.sessionId) {
      throw new ConflictError("Project workspace has a different current conversation.");
    }
    return { workspaceId: input.workspaceId, sessionId: input.sessionId, workspacePath };
  }
  db.prepare("UPDATE workspaces SET state = 'initializing' WHERE id = ?").run(input.workspaceId);
  await initializeWorkspace({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    sessionId: input.sessionId,
    repoRootPath: repository.root_path,
    workspacePath,
    branchName: workspace.git_branch,
    worktreeBase: input.baseCommit,
    parentBranch: input.sourceBranch ?? repository.git_default_branch,
    repoOriginUrl: repository.git_origin_url,
  });
  const prepared = getWorkspaceRaw(db, input.workspaceId);
  if (prepared?.state !== "ready" || prepared.current_session_id !== input.sessionId) {
    throw new ConflictError(prepared?.error_message ?? "Project workspace preparation failed.");
  }
  return { workspaceId: input.workspaceId, sessionId: input.sessionId, workspacePath };
}
