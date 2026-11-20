/** Answers the operations in `shared/api/workspaces.ts`. */

import path from "path";
import fs from "fs";
import { setupFile } from "../services/setup-status";
import * as api from "@shared/api/workspaces";
import type { ParsedInputOf } from "@shared/api/op";
import { uuidv7 } from "@shared/lib/uuid";
import type { Origin } from "@zvada/agent-server/protocol";
import { getDatabase } from "../lib/database";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { groupWorkspacesByRepo, toWorkspace } from "../lib/workspace-grouping";
import { loadWorkspace } from "../middleware/workspace-loader";
import {
  getAllRepositorySummaries,
  getRepositoryById,
  getWorkspaceById,
  getWorkspaceRaw,
  getWorkspacesByRepo,
} from "../db";
import { cloudAccount } from "../services/agent/cloud/config";
import { ensureCloudSession } from "../services/agent/cloud/driver";
import {
  createCloudWorkspace,
  retryCloudWorkspace,
} from "../services/cloud-workspace-init.service";
import {
  getGhIdentity,
  ghLoginDone,
  logoutGh,
  startGhLogin,
} from "../services/gh-identity.service";
import { resolveNode } from "../services/node/driver";
import { fetchAndApplyPrStatus } from "../services/pr-snapshot.service";
import {
  prepareLocalEnvironment,
  readWorkspaceEnvironment,
} from "../services/project-environment.service";
import { invalidate } from "../services/query-engine";
import {
  archiveWorkspace,
  unarchiveWorkspace,
  wakeWorkspace,
} from "../services/workspace-archive.service";
import {
  deleteFailedWorkspace,
  initializeWorkspace,
  pickWorkspaceName,
  retryWorkspaceInit,
} from "../services/workspace-init.service";
import { setWorkspaceStatus } from "../services/workspace-status.service";
import { handle } from "./registry";

/** How long `connectCloudWorkspace` waits for the channel to open before answering. */
const CONNECT_ANSWER_LIMIT_MS = 5_000;

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
  // Cloud: the row now, the sandbox in the background. Progress arrives as
  // workspace.state events through the cloud driver.
  if (input.location === "cloud") {
    if (!getRepositoryById(getDatabase(), input.repository_id))
      throw new NotFoundError("Repository not found");
    // Signed out is a state the person can fix, not a server fault.
    if (!cloudAccount()) {
      throw new ValidationError(
        "Sign in to Deus Cloud to create cloud workspaces (Settings → Cloud)."
      );
    }
    return createCloudWorkspace({
      repositoryId: input.repository_id,
      sourceBranch: input.source_branch,
      organizationId: input.organization_id,
    });
  }

  const { workspaceId } = await createLocalWorkspace(input);
  return { workspaceId };
}

/**
 * A workspace on this computer: the row now, everything slow in the
 * background. The pipeline (services/workspace-init) fetches origin, makes
 * the worktree and opens the first chat alongside setup, under the id minted
 * here (`first_session_id`); each stage and any failure reaches clients on
 * `workspaces`, and a failure can be retried on this same row. `startedBy`
 * is who started it when not the person; `admit`, run synchronously right
 * before the insert, may refuse it (the operator's host counts its setups).
 */
export async function createLocalWorkspace(
  input: {
    repository_id: string;
    source_branch?: string;
    target_branch?: string;
    pr_title?: string;
    pr_url?: string;
    pr_number?: number;
  },
  options: { startedBy?: Origin; admit?: () => void } = {}
): Promise<{ workspaceId: string; firstSessionId: string }> {
  const db = getDatabase();
  const repo = getRepositoryById(db, input.repository_id);
  if (!repo) throw new NotFoundError("Repository not found");
  const rootPath = repo.root_path;
  if (!rootPath) {
    throw new ConflictError(
      `${repo.name} is not on this computer, so it can only run in the cloud. Turn on Cloud, or open its folder on this Mac first.`
    );
  }
  const sourceBranch = input.source_branch || repo.git_default_branch || "main";
  const workspaceId = uuidv7();
  const firstSessionId = uuidv7();
  const { slug, branchName } = await pickWorkspaceName(rootPath);

  options.admit?.();
  db.prepare(
    `INSERT INTO workspaces (
       id, repository_id, slug, title, git_branch, git_source_branch,
       git_target_branch, pr_url, pr_number, state, first_session_id, started_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?, datetime('now'))`
  ).run(
    workspaceId,
    input.repository_id,
    slug,
    input.pr_title || null,
    branchName,
    sourceBranch,
    input.target_branch || repo.git_default_branch || "main",
    input.pr_url || null,
    input.pr_number || null,
    firstSessionId,
    options.startedBy && options.startedBy.kind !== "person"
      ? JSON.stringify(options.startedBy)
      : null
  );

  // Not awaited, and it never rejects: the pipeline records its own failure.
  void initializeWorkspace({
    workspaceId,
    repoRootPath: rootPath,
    workspacePath: path.join(rootPath, ".deus", slug),
    branchName,
    sourceBranch,
    repoOriginUrl: repo.git_origin_url,
  });

  // Clients see the row in `initializing` at once.
  invalidate(["workspaces"]);
  return { workspaceId, firstSessionId };
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
  handle(api.workspace, ({ workspaceId }) => readWorkspace(workspaceId)),
  handle(api.workspaceEnvironment, ({ workspaceId }) => {
    const { workspace, workspacePath } = loadWorkspace(workspaceId);
    return readWorkspaceEnvironment(workspace, workspacePath);
  }),
  handle(api.setupLogs, ({ workspaceId }) => {
    const { workspace } = loadWorkspace(workspaceId);
    try {
      return {
        logs: fs.readFileSync(setupFile(workspace.id, "log"), "utf8"),
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
  handle(api.ghLogin, startGhLogin),
  handle(api.ghLoginDone, ghLoginDone),
  handle(api.ghLogout, logoutGh),

  handle(api.createWorkspace, createWorkspace),
  handle(api.updateWorkspace, async ({ workspaceId }) => {
    await unarchiveWorkspace(workspaceId);
    invalidate(["workspaces", "sessions"]);
  }),
  handle(api.archiveWorkspace, async ({ workspaceId }) => {
    await archiveWorkspace(workspaceId);
    invalidate(["workspaces"]);
  }),
  handle(api.updateWorkspaceTitle, ({ workspaceId, title }) => {
    const db = getDatabase();
    if (!getWorkspaceRaw(db, workspaceId)) throw new NotFoundError("Workspace not found");
    db.prepare("UPDATE workspaces SET title = ? WHERE id = ?").run(title, workspaceId);
    invalidate(["workspaces"]);
  }),
  handle(api.updateWorkspaceStatus, ({ workspaceId, status }) => {
    setWorkspaceStatus(workspaceId, status);
    invalidate(["workspaces"]);
  }),
  handle(api.retryWorkspaceInit, ({ workspaceId }) => {
    const workspace = getWorkspaceRaw(getDatabase(), workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.kind === "cloud") retryCloudWorkspace(workspaceId);
    else retryWorkspaceInit(workspaceId);
  }),
  // Only a workspace that never started: see deleteFailedWorkspace.
  handle(api.deleteWorkspace, ({ workspaceId }) => deleteFailedWorkspace(workspaceId)),
  handle(api.retrySetup, ({ workspaceId }) => {
    const { workspace, workspacePath } = loadWorkspace(workspaceId);
    if (workspace.kind === "cloud") {
      throw new ValidationError("Prepare the cloud environment in a new workspace.");
    }
    if (workspace.state !== "ready")
      throw new ValidationError("Setup can only be retried in a ready workspace.");
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
  handle(api.connectCloudWorkspace, async ({ workspaceId }) => {
    const workspace = getWorkspaceById(getDatabase(), workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.kind !== "cloud" || workspace.state === "archived") return { ok: false };
    // The channel ends at the platform, reachable while the sandbox sleeps, and
    // its snapshot carries the session's status: how a restarted backend learns
    // "paused". Attaching wakes nothing; only a send or an explicit wake does.
    // Answered once the channel is open (what the client reads next needs it), or
    // at the limit; the connect goes on either way.
    const sessionId = workspace.current_session_id;
    if (sessionId) {
      const opened = ensureCloudSession(sessionId).then(
        () => {},
        (error) => {
          console.warn(`[WORKSPACE] cloud channel connect failed for ${workspace.id}: ${error}`);
        }
      );
      let limit: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        opened,
        new Promise<void>((resolve) => {
          limit = setTimeout(resolve, CONNECT_ANSWER_LIMIT_MS);
        }),
      ]);
      clearTimeout(limit);
    }
    return { ok: true };
  }),
];
