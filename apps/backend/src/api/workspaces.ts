/** Answers the operations in `shared/api/workspaces.ts`. */

import fs from "fs";
import { stripVTControlCharacters } from "node:util";
import { setupFile } from "../services/setup-status";
import * as api from "@shared/api/workspaces";
import { getDatabase } from "../lib/database";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { groupWorkspacesByRepo, toWorkspace } from "../lib/workspace-grouping";
import { loadWorkspace } from "../middleware/workspace-loader";
import {
  getAllRepositories,
  getArchivedWorkspaces,
  getWorkspaceById,
  getWorkspaceRaw,
  getWorkspacesByRepo,
  rename,
} from "../db";
import { ensureCloudSession } from "../services/agent/cloud/driver";
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
import { createWorkspace, retryWorkspaceInit } from "../services/workspace-init.service";
import { retryCloudWorkspace } from "../services/cloud-workspace-init.service";
import { deleteFailedWorkspace } from "../services/workspace-lifecycle";
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

export default [
  handle(api.workspaces, ({ state }) => {
    const db = getDatabase();
    // `error` is in the default so a failed provision stays visible in the sidebar.
    return groupWorkspacesByRepo(
      getWorkspacesByRepo(db, state ?? "ready,initializing,error"),
      getAllRepositories(db)
    );
  }),
  handle(api.archivedWorkspaces, ({ repositoryId }) =>
    getArchivedWorkspaces(getDatabase(), repositoryId)
  ),
  handle(api.workspace, ({ workspaceId }) => readWorkspace(workspaceId)),
  handle(api.workspaceEnvironment, ({ workspaceId }) => {
    const { workspace, workspacePath } = loadWorkspace(workspaceId);
    return readWorkspaceEnvironment(workspace, workspacePath);
  }),
  handle(api.setupLogs, ({ workspaceId }) => {
    const { workspace } = loadWorkspace(workspaceId);
    try {
      const logs = fs.readFileSync(setupFile(workspace.id, "log"), "utf8");
      return { logs: stripVTControlCharacters(logs) };
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
  handle(api.updateWorkspace, ({ workspaceId }) => unarchiveWorkspace(workspaceId)),
  handle(api.archiveWorkspace, ({ workspaceId }) => archiveWorkspace(workspaceId)),
  handle(api.updateWorkspaceTitle, ({ workspaceId, title }) => {
    const db = getDatabase();
    if (!getWorkspaceRaw(db, workspaceId)) throw new NotFoundError("Workspace not found");
    rename(db, "workspaces", workspaceId, title);
    invalidate(["workspaces"]);
  }),
  handle(api.updateWorkspaceStatus, ({ workspaceId, status }) => {
    setWorkspaceStatus(workspaceId, status);
    invalidate(["workspaces"]);
  }),
  handle(api.retryWorkspaceInit, ({ workspaceId }) => {
    const workspace = getWorkspaceRaw(getDatabase(), workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.kind === "cloud") return retryCloudWorkspace(workspaceId);
    return retryWorkspaceInit(workspaceId);
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
