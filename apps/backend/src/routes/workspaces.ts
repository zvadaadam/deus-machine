import { Hono } from "hono";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn, execFile, execSync } from "child_process";
import { promisify } from "util";
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../lib/database";
import { withWorkspace, computeWorkspacePath } from "../middleware/workspace-loader";
import { NotFoundError, ValidationError } from "../lib/errors";
import { parseBody, PatchWorkspaceBody, CreateWorkspaceBody } from "../lib/schemas";
import { generateUniqueName } from "../services/workspace.service";
import {
  readManifestWithFallback,
  getSetupCommand,
  getArchiveCommand,
  getDeusEnv,
  getNormalizedTasks,
  runSetupScript,
  isManifestCommandSafe,
} from "../services/manifest.service";
import { initializeWorkspace } from "../services/workspace-init.service";
import { autoProgressStatus, setWorkspaceStatus } from "../services/workspace-status.service";
import {
  getAllWorkspaces,
  getWorkspacesByRepo,
  getWorkspaceById,
  getWorkspaceRaw,
  getWorkspaceForMiddleware,
  getRepositoryById,
  getAllRepositorySummaries,
  getSessionRaw,
  getSessionsByWorkspaceId,
} from "../db";
import type { WorkspaceWithDetailsRow } from "../db";
import { invalidate } from "../services/query-engine";

const execFileAsync = promisify(execFile);

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

app.get("/workspaces", (c) => {
  const db = getDatabase();
  const workspaces = getAllWorkspaces(db);
  return c.json(workspaces.map((ws) => ({ ...ws, workspace_path: computeWorkspacePath(ws) })));
});

app.get("/workspaces/by-repo", (c) => {
  const db = getDatabase();
  const stateParam = c.req.query("state");
  const workspaces = getWorkspacesByRepo(db, stateParam);

  const grouped: Record<string, any> = {};
  workspaces.forEach((workspace) => {
    const repoId = workspace.repository_id || "unknown";
    if (!grouped[repoId]) {
      grouped[repoId] = {
        repo_id: repoId,
        repo_name: workspace.repo_name || "Unknown",
        sort_order: workspace.repo_sort_order || 999,
        git_origin_url: workspace.git_origin_url ?? null,
        workspaces: [],
      };
    }
    grouped[repoId].workspaces.push({
      ...workspace,
      workspace_path: computeWorkspacePath(workspace),
    });
  });

  // Backfill repos that have no matching workspaces (e.g. all archived)
  // so they still appear in the sidebar.
  const allRepos = getAllRepositorySummaries(db);
  for (const repo of allRepos) {
    if (!grouped[repo.id]) {
      grouped[repo.id] = {
        repo_id: repo.id,
        repo_name: repo.name,
        sort_order: repo.sort_order ?? 999,
        git_origin_url: repo.git_origin_url ?? null,
        workspaces: [],
      };
    }
  }

  const result = Object.values(grouped).sort((a: any, b: any) => a.sort_order - b.sort_order);
  return c.json(result);
});

app.get("/workspaces/:id", (c) => {
  const db = getDatabase();
  const workspace = getWorkspaceById(db, c.req.param("id"));
  if (!workspace) throw new NotFoundError("Workspace not found");
  return c.json({ ...workspace, workspace_path: computeWorkspacePath(workspace) });
});

app.patch("/workspaces/:id", async (c) => {
  const db = getDatabase();
  const id = c.req.param("id");
  const { state, status } = parseBody(PatchWorkspaceBody, await c.req.json());

  if (status) {
    setWorkspaceStatus(id, status);
  }

  if (state) {
    db.prepare("UPDATE workspaces SET state = ? WHERE id = ?").run(state, id);

    if (state === "archived") {
      autoProgressStatus(id, "done", { force: true });

      // Run archive lifecycle hook (best-effort)
      try {
        const ws = getWorkspaceById(db, id);
        if (ws && ws.root_path) {
          const wsPath = computeWorkspacePath(ws);
          const manifest = readManifestWithFallback(wsPath, ws.root_path);
          const archiveCmd = manifest ? getArchiveCommand(manifest) : null;
          if (archiveCmd) {
            if (!isManifestCommandSafe(archiveCmd)) {
              console.warn(
                `[MANIFEST] Rejected unsafe archive command for workspace ${id}: ${archiveCmd}`
              );
            } else {
              const archiveEnv = getDeusEnv(manifest!, {
                id: ws.id,
                rootPath: ws.root_path,
                workspacePath: wsPath,
              });
              const archiveProc = spawn("sh", ["-c", archiveCmd], {
                cwd: wsPath,
                env: { ...process.env, ...archiveEnv },
                stdio: "ignore",
                detached: false,
              });
              archiveProc.on("error", (err) => {
                console.error(`Archive hook error for workspace ${id}:`, err.message);
              });
              archiveProc.unref();
            }
          }
        }
      } catch (err) {
        console.warn("[WORKSPACE] Archive lifecycle hook failed (continuing):", err);
      }
    }

    // Unarchive: restore done → in-progress
    if (state === "ready") {
      const ws = getWorkspaceRaw(db, id);
      if (ws?.status === "done") {
        autoProgressStatus(id, "in-progress", { force: true });
      }
    }
  }
  const updated = getWorkspaceRaw(db, id);
  invalidate(["workspaces", "sessions", "stats"]);
  return c.json(updated);
});

// Create workspace
app.post("/workspaces", async (c) => {
  const db = getDatabase();
  const { repository_id, source_branch, pr_number, pr_url, pr_title, target_branch } = parseBody(
    CreateWorkspaceBody,
    await c.req.json()
  );

  const repo = getRepositoryById(db, repository_id);
  if (!repo) throw new NotFoundError("Repository not found");

  const workspace_name = generateUniqueName(db);
  const parent_branch = source_branch || repo.git_default_branch || "main";
  const workspaceId = uuidv7();

  let branchPrefix = "workspace";
  try {
    const gitUser = execSync("git config user.name", { cwd: repo.root_path!, encoding: "utf8" })
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");
    if (gitUser) branchPrefix = gitUser;
  } catch {}
  const placeholderBranchName = `${branchPrefix}/${workspace_name}`;

  // ─── IMPORTANT: Remote-first branch strategy ───────────────────────
  // We ALWAYS want worktrees branched from origin/<parent_branch>, not
  // local <parent_branch>. Diffs are computed against origin/<branch>
  // (see resolve_parent_branch in git.rs and git.service.ts). If origin
  // is stale, the merge-base drifts and every file since the divergence
  // shows as "changed" — producing hundreds of phantom file changes.
  //
  // Fetch the remote branch before creating the worktree so that:
  // 1. The worktree starts from the latest upstream commit
  // 2. Diff merge-base matches what we branched from (zero phantom changes)
  // 3. PRs will be clean against the upstream target
  //
  // This is a non-blocking fetch (~1-3s on a warm connection). Workspace
  // creation is already async (worktree add runs in a child process) and
  // correctness matters more here.
  // ───────────────────────────────────────────────────────────────────
  try {
    await execFileAsync("git", ["fetch", "origin", parent_branch], {
      cwd: repo.root_path!,
      timeout: 15000,
    });
  } catch (fetchErr) {
    // Non-fatal: if fetch fails (offline, no remote, etc.), fall back to
    // whatever local state we have. The worktree will still be created
    // from the local branch — diffs might be off but it's better than
    // blocking workspace creation entirely.
    console.warn(
      `[WORKSPACE] git fetch origin ${parent_branch} failed (continuing with local):`,
      fetchErr
    );
  }

  db.prepare(
    `
    INSERT INTO workspaces (
      id, repository_id, slug, title, git_branch,
      git_target_branch, pr_url, pr_number, state, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `
  ).run(
    workspaceId,
    repository_id,
    workspace_name,
    pr_title || null,
    placeholderBranchName,
    target_branch || repo.git_default_branch || "main",
    pr_url || null,
    pr_number || null,
    "initializing"
  );

  // Branch from origin/<parent_branch> when available (fetched above).
  // Falls back to local <parent_branch> if remote doesn't exist.
  const worktreeBase = await (async () => {
    try {
      await execFileAsync(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${parent_branch}`],
        { cwd: repo.root_path!, timeout: 2000 }
      );
      return `origin/${parent_branch}`;
    } catch {
      return parent_branch;
    }
  })();

  const workspacePath = path.join(repo.root_path!, ".deus", workspace_name);

  // Fire-and-forget: run the init pipeline async (don't await).
  // Pipeline handles: worktree creation → deps install → .env copy → session creation.
  // Progress events flow: stdout → Electron main process → IPC events → Frontend.
  // On fatal failure: reverse cleanup (rm dir, prune worktree, delete branch).
  initializeWorkspace({
    workspaceId,
    repositoryId: repository_id,
    repoRootPath: repo.root_path!,
    workspacePath,
    branchName: placeholderBranchName,
    worktreeBase,
    parentBranch: parent_branch,
  })
    .then(() => {
      // Workspace is ready — check for manifest setup script
      const manifest = readManifestWithFallback(workspacePath, repo.root_path!);
      const setupCmd = manifest ? getSetupCommand(manifest) : null;
      if (setupCmd && manifest) {
        db.prepare("UPDATE workspaces SET setup_status = 'running' WHERE id = ?").run(workspaceId);
        const setupEnv = getDeusEnv(manifest, {
          id: workspaceId,
          rootPath: repo.root_path!,
          workspacePath,
        });
        runSetupScript(db, workspaceId, setupCmd, setupEnv, workspacePath);
      }
    })
    .catch((err) => {
      // Belt-and-suspenders: initializeWorkspace handles its own errors,
      // but if something truly unexpected escapes, don't leave workspace stuck.
      console.error("[WORKSPACE] Unhandled init pipeline error:", err);
      try {
        db.prepare(
          "UPDATE workspaces SET state = 'error', init_stage = 'unhandled', error_message = 'Unhandled init pipeline error' WHERE id = ? AND state = 'initializing'"
        ).run(workspaceId);
        invalidate(["workspaces", "stats"]);
      } catch {}
    });

  const workspace = getWorkspaceForMiddleware(db, workspaceId);
  if (!workspace) throw new NotFoundError("Workspace not found after creation");

  // Push immediately so clients see the workspace in 'initializing' state.
  // Query-protocol subscribers get snapshots + q:invalidate for unmounted caches.
  // The init pipeline will invalidate again when it transitions to 'ready'.
  invalidate(["workspaces", "stats"]);

  return c.json({ ...workspace, workspace_path: computeWorkspacePath(workspace) });
});

// List all sessions for a workspace (used by chat tab reconstruction)
app.get("/workspaces/:id/sessions", (c) => {
  const db = getDatabase();
  const workspaceId = c.req.param("id");
  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new NotFoundError("Workspace not found");
  const sessions = getSessionsByWorkspaceId(db, workspaceId);
  return c.json(sessions);
});

// Create a new session for an existing workspace
app.post("/workspaces/:id/sessions", (c) => {
  const db = getDatabase();
  const workspaceId = c.req.param("id");

  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new NotFoundError("Workspace not found");

  const sessionId = uuidv7();

  const createSession = db.transaction(() => {
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, status, updated_at) VALUES (?, ?, 'idle', datetime('now'))"
    ).run(sessionId, workspaceId);

    db.prepare(
      "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId, workspaceId);
  });

  createSession();
  invalidate(["workspaces", "sessions", "stats"]);

  const session = getSessionRaw(db, sessionId);
  return c.json(session);
});

// ─── Manifest & Task Endpoints ──────────────────────────────

// Get parsed manifest + normalized tasks for a workspace
app.get("/workspaces/:id/manifest", withWorkspace, (c) => {
  const workspace = c.get("workspace");
  const workspacePath = c.get("workspacePath");
  if (!workspace.root_path) {
    return c.json({ manifest: null, tasks: [] });
  }
  const manifest = readManifestWithFallback(workspacePath, workspace.root_path);
  if (!manifest) return c.json({ manifest: null, tasks: [] });
  const tasks = getNormalizedTasks(manifest);
  return c.json({ manifest, tasks });
});

// Retry failed setup
app.post("/workspaces/:id/retry-setup", withWorkspace, (c) => {
  const db = getDatabase();
  const workspace = c.get("workspace");
  const workspacePath = c.get("workspacePath");

  if (workspace.setup_status !== "failed") {
    throw new ValidationError("Can only retry when setup_status is failed");
  }

  if (!workspace.root_path) {
    throw new ValidationError("Repository path not found");
  }

  // Re-read manifest (AI agent may have fixed it, or it was added to repo root via settings)
  const manifest = readManifestWithFallback(workspacePath, workspace.root_path);
  const setupCmd = manifest ? getSetupCommand(manifest) : null;
  if (!setupCmd || !manifest) {
    db.prepare(
      "UPDATE workspaces SET setup_status = 'none', error_message = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(workspace.id);
    return c.json({ setup_status: "none" });
  }

  db.prepare(
    "UPDATE workspaces SET setup_status = 'running', error_message = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(workspace.id);

  const setupEnv = getDeusEnv(manifest, {
    id: workspace.id,
    rootPath: workspace.root_path,
    workspacePath,
  });
  runSetupScript(db, workspace.id, setupCmd, setupEnv, workspacePath);

  return c.json({ setup_status: "running" });
});

// Get setup logs
app.get("/workspaces/:id/setup-logs", withWorkspace, (c) => {
  const workspace = c.get("workspace");
  const setupLogPath = path.join(os.tmpdir(), `deus-${workspace.id}-setup.log`);
  try {
    if (!fs.existsSync(setupLogPath)) return c.json({ logs: null });
    const logs = fs.readFileSync(setupLogPath, "utf8");
    return c.json({ logs });
  } catch {
    return c.json({ logs: null });
  }
});

// Run a task — validates task exists, returns info for frontend PTY spawn
app.post("/workspaces/:id/tasks/:name/run", withWorkspace, (c) => {
  const workspace = c.get("workspace");
  const workspacePath = c.get("workspacePath");
  const taskName = c.req.param("name");

  if (!workspace.root_path) {
    throw new ValidationError("Repository path not found");
  }

  const manifest = readManifestWithFallback(workspacePath, workspace.root_path);
  if (!manifest) throw new NotFoundError("No deus.json manifest found");

  const tasks = getNormalizedTasks(manifest);
  const task = tasks.find((t) => t.name === taskName);
  if (!task) throw new NotFoundError(`Task "${taskName}" not found in manifest`);

  const ptyId = `task-${workspace.id}-${taskName}-${Date.now()}`;
  const env = {
    ...(manifest.env ?? {}),
    ...task.env,
    DEUS_ROOT_PATH: workspace.root_path,
    DEUS_WORKSPACE_PATH: workspacePath,
    DEUS_WORKSPACE_ID: workspace.id,
  };

  return c.json({
    ptyId,
    command: task.command,
    cwd: workspacePath,
    env,
    persistent: task.persistent,
    mode: task.mode,
  });
});

export default app;
