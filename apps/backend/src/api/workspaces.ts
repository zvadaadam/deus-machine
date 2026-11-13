/** Answers the operations in `shared/api/workspaces.ts`. */

import path from "path";
import fs from "fs";
import os from "os";
import { execFile, execSync } from "child_process";
import { promisify } from "util";
import * as api from "@shared/api/workspaces";
import type { ParsedInputOf } from "@shared/api/op";
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../lib/database";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { groupWorkspacesByRepo, toWorkspace } from "../lib/workspace-grouping";
import { loadWorkspace } from "../middleware/workspace-loader";
import {
  getAllRepositorySummaries,
  getAllWorkspaces,
  getRepositoryById,
  getStats,
  getWorkspaceById,
  getWorkspaceRaw,
  getWorkspacesByRepo,
} from "../db";
import { getCloudConfig } from "../services/agent/cloud/config";
import { ensureCloudSession } from "../services/agent/cloud/driver";
import { createCloudWorkspace } from "../services/cloud-workspace-init.service";
import { getGhIdentity } from "../services/gh-identity.service";
import { resolveNode } from "../services/node/driver";
import { fetchAndApplyPrStatus } from "../services/pr-snapshot.service";
import {
  prepareLocalEnvironment,
  readWorkspaceEnvironment,
} from "../services/project-environment.service";
import { invalidate } from "../services/query-engine";
import { generateUniqueName } from "../services/workspace.service";
import {
  archiveWorkspace,
  unarchiveWorkspace,
  wakeWorkspace,
} from "../services/workspace-archive.service";
import { initializeWorkspace } from "../services/workspace-init.service";
import { autoProgressStatus, setWorkspaceStatus } from "../services/workspace-status.service";
import { handle } from "./registry";

const execFileAsync = promisify(execFile);

/** The workspace's files, on whichever node owns them (this computer or its cloud sandbox). */
function nodeOf(workspaceId: string) {
  const { workspace, workspacePath } = loadWorkspace(workspaceId);
  return resolveNode(workspace, workspacePath);
}

/** One workspace as clients read it. Also what the desktop shell asks for over HTTP. */
export function readWorkspace(workspaceId: string) {
  const workspace = getWorkspaceById(getDatabase(), workspaceId);
  if (!workspace) throw new NotFoundError("Workspace not found");
  return toWorkspace(workspace);
}

async function createWorkspace(
  input: ParsedInputOf<typeof api.createWorkspace>
): Promise<{ workspaceId: string }> {
  const db = getDatabase();
  const repo = getRepositoryById(db, input.repository_id);
  if (!repo) throw new NotFoundError("Repository not found");

  // Cloud: the row now, the sandbox in the background. Progress arrives as
  // workspace.state events through the cloud driver.
  if (input.location === "cloud") {
    // Signed out is a state the person can fix, not a server fault.
    if (!getCloudConfig()) {
      throw new ValidationError(
        "Sign in to Deus Cloud to create cloud workspaces (Settings → Cloud)."
      );
    }
    return createCloudWorkspace({
      repositoryId: input.repository_id,
      sourceBranch: input.source_branch,
    });
  }

  const name = generateUniqueName(db);
  const parentBranch = input.source_branch || repo.git_default_branch || "main";
  const workspaceId = uuidv7();

  let branchPrefix = "workspace";
  try {
    const gitUser = execSync("git config user.name", { cwd: repo.root_path!, encoding: "utf8" })
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");
    if (gitUser) branchPrefix = gitUser;
  } catch {
    // No git identity: the default prefix stands.
  }
  const branchName = `${branchPrefix}/${name}`;

  // Worktrees branch from origin/<parent>, never the local branch: diffs are
  // measured against origin (git.service resolveParentBranch), so a stale local
  // branch would show every upstream commit since as a change. Fetch first so
  // the worktree starts at the latest upstream commit and the merge-base
  // matches. A failed fetch (offline, no remote) falls back to local state:
  // a workspace with a rough diff beats no workspace.
  try {
    await execFileAsync("git", ["fetch", "origin", parentBranch], {
      cwd: repo.root_path!,
      timeout: 15000,
    });
  } catch (error) {
    console.warn(
      `[WORKSPACE] git fetch origin ${parentBranch} failed (continuing with local):`,
      error
    );
  }

  db.prepare(
    `INSERT INTO workspaces (
       id, repository_id, slug, title, git_branch,
       git_target_branch, pr_url, pr_number, state, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    workspaceId,
    input.repository_id,
    name,
    input.pr_title || null,
    branchName,
    input.target_branch || repo.git_default_branch || "main",
    input.pr_url || null,
    input.pr_number || null,
    "initializing"
  );

  const worktreeBase = await execFileAsync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${parentBranch}`],
    { cwd: repo.root_path!, timeout: 2000 }
  ).then(
    () => `origin/${parentBranch}`,
    () => parentBranch
  );

  // Not awaited: checkout, env files, setup and the first session run in the
  // background and report through `workspaces`. The pipeline cleans up after
  // its own failures; this catch is for one that escapes it.
  initializeWorkspace({
    workspaceId,
    repositoryId: input.repository_id,
    repoRootPath: repo.root_path!,
    workspacePath: path.join(repo.root_path!, ".deus", name),
    branchName,
    worktreeBase,
    parentBranch,
    repoOriginUrl: repo.git_origin_url,
  }).catch((error) => {
    console.error("[WORKSPACE] Unhandled init pipeline error:", error);
    try {
      db.prepare(
        "UPDATE workspaces SET state = 'error', init_stage = 'unhandled', error_message = 'Unhandled init pipeline error' WHERE id = ? AND state = 'initializing'"
      ).run(workspaceId);
      invalidate(["workspaces", "stats"]);
    } catch {
      // The database is gone too; nothing left to record.
    }
  });

  // Clients see the row in `initializing` at once.
  invalidate(["workspaces", "stats"]);
  return { workspaceId };
}

async function updateWorkspace({
  workspaceId,
  state,
  status,
}: ParsedInputOf<typeof api.updateWorkspace>): Promise<void> {
  const db = getDatabase();
  if (status) setWorkspaceStatus(workspaceId, status);
  if (state === "archived") await archiveWorkspace(workspaceId);
  else if (state === "ready") {
    await unarchiveWorkspace(workspaceId);
    // A restored workspace that was done is in progress again.
    if (getWorkspaceRaw(db, workspaceId)?.status === "done") {
      autoProgressStatus(workspaceId, "in-progress", { force: true });
    }
  } else if (state) {
    db.prepare("UPDATE workspaces SET state = ? WHERE id = ?").run(state, workspaceId);
  }
  invalidate(["workspaces", "sessions", "stats"]);
}

export default [
  handle(api.workspaces, ({ state }) => {
    const db = getDatabase();
    // `error` is in the default so a failed provision stays visible in the sidebar.
    return groupWorkspacesByRepo(
      getWorkspacesByRepo(db, state ?? "ready,initializing,error"),
      getAllRepositorySummaries(db)
    );
  }),
  handle(api.stats, () => getStats(getDatabase())),
  handle(api.workspace, ({ workspaceId }) => readWorkspace(workspaceId)),
  handle(api.allWorkspaces, () => getAllWorkspaces(getDatabase()).map(toWorkspace)),
  handle(api.workspaceEnvironment, ({ workspaceId }) => {
    const { workspace, workspacePath } = loadWorkspace(workspaceId);
    return readWorkspaceEnvironment(workspace, workspacePath);
  }),
  handle(api.setupLogs, ({ workspaceId }) => {
    const { workspace } = loadWorkspace(workspaceId);
    try {
      return {
        logs: fs.readFileSync(path.join(os.tmpdir(), `deus-${workspace.id}-setup.log`), "utf8"),
      };
    } catch {
      return { logs: null };
    }
  }),

  handle(api.diffStats, ({ workspaceId }) => nodeOf(workspaceId).diffStats()),
  handle(api.diffFiles, ({ workspaceId }) => nodeOf(workspaceId).diffFiles()),
  handle(api.diffFile, async ({ workspaceId, file }) => {
    const outcome = await nodeOf(workspaceId).diffFile(file);
    if (!outcome.ok) throw AppError.fromBody(outcome.status, outcome.body);
    const { ok: _ok, ...diff } = outcome;
    return diff;
  }),
  handle(api.prStatus, ({ workspaceId }) => {
    const { workspace, workspacePath } = loadWorkspace(workspaceId);
    // Guarded by epoch and shared with background refreshes, so an older
    // lookup that finishes late never overwrites a newer snapshot.
    return fetchAndApplyPrStatus(workspace.id, workspacePath);
  }),
  handle(api.ghStatus, () => getGhIdentity()),

  handle(api.createWorkspace, createWorkspace),
  handle(api.updateWorkspace, updateWorkspace),
  handle(api.archiveWorkspace, async ({ workspaceId }) => {
    await archiveWorkspace(workspaceId);
    invalidate(["workspaces", "stats"]);
  }),
  handle(api.updateWorkspaceTitle, ({ workspaceId, title }) => {
    const db = getDatabase();
    if (!getWorkspaceRaw(db, workspaceId)) throw new NotFoundError("Workspace not found");
    db.prepare("UPDATE workspaces SET title = ? WHERE id = ?").run(title, workspaceId);
    invalidate(["workspaces"]);
  }),
  handle(api.updateWorkspaceStatus, ({ workspaceId, status }) => {
    setWorkspaceStatus(workspaceId, status);
    invalidate(["workspaces", "stats"]);
  }),
  handle(api.retrySetup, ({ workspaceId }) => {
    const { workspace, workspacePath } = loadWorkspace(workspaceId);
    if (workspace.kind === "cloud") {
      throw new ValidationError("Prepare the cloud environment in a new workspace.");
    }
    if (workspace.setup_status !== "failed") {
      throw new ValidationError("Setup is not in a failed state.");
    }
    void prepareLocalEnvironment(workspace.id, workspacePath, workspace.git_origin_url);
  }),
  handle(api.runTask, async ({ workspaceId, taskName }) => {
    // Resolved here so a stale menu never runs a command the project removed.
    const { workspace, workspacePath } = loadWorkspace(workspaceId);
    const environment = await readWorkspaceEnvironment(workspace, workspacePath);
    const task = environment.tasks.find((candidate) => candidate.name === taskName);
    if (!task || !environment.project) {
      throw new NotFoundError("This command is no longer configured.");
    }
    const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    // The terminal's own node supplies the environment: local dotenv or cloud secrets.
    return { command: `/bin/sh -ec ${quote(task.command)}` };
  }),

  handle(api.wakeCloudWorkspace, ({ workspaceId }) => wakeWorkspace(workspaceId)),
  handle(api.connectCloudWorkspace, ({ workspaceId }) => {
    const workspace = getWorkspaceById(getDatabase(), workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.kind !== "cloud" || workspace.state === "archived") return { ok: false };
    // The channel ends at the platform, reachable while the sandbox sleeps, and
    // its snapshot carries the session's status: how a restarted backend learns
    // "paused". Attaching wakes nothing; only a send or an explicit wake does.
    const sessionId = workspace.current_session_id;
    if (sessionId) {
      void ensureCloudSession(sessionId).catch((error) => {
        console.warn(`[WORKSPACE] cloud channel connect failed for ${workspace.id}: ${error}`);
      });
    }
    return { ok: true };
  }),
];
