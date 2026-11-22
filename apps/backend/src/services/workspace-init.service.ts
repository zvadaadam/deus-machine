/** Admit and restart workspaces. The local checkout runs in the background. */
import path from "node:path";
import type { ParsedInputOf } from "@shared/api/op";
import type * as api from "@shared/api/workspaces";
import { uuidv7 } from "@shared/lib/uuid";
import type { Origin } from "@shared/types/workspace";
import { getRepositoryById } from "../db";
import { getDatabase } from "../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { processGroupsStopped } from "../lib/process-groups";
import { computeWorkspacePath } from "../middleware/workspace-loader";
import { invalidate } from "./query-engine";
import { cloudAccount } from "./agent/cloud/config";
import { createCloudWorkspace } from "./cloud-workspace-init.service";
import { SETUP_INTERRUPTED } from "./setup-status";
import {
  initializeWorkspace,
  OWNS_WORKTREE,
  pickWorkspaceName,
  removeWorktree,
} from "./workspace-checkout";
import {
  claimLocalRetry,
  failInterruptedStart,
  changeWorkspaceState,
  insertLocalWorkspace,
  interruptedStarts,
  runningSetups,
  setSetupStatus,
} from "./workspace-lifecycle";

type CreateWorkspaceInput = ParsedInputOf<typeof api.createWorkspace>;

export async function createWorkspace(
  input: CreateWorkspaceInput
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
 * Reserve the first chat before starting the checkout in the background.
 * The operator's admission check counts setups immediately before the insert.
 */
export async function createLocalWorkspace(
  input: Omit<CreateWorkspaceInput, "location" | "organization_id">,
  options: { startedBy?: Origin; admit?: () => void } = {}
): Promise<{ workspaceId: string; firstSessionId: string }> {
  const repo = getRepositoryById(getDatabase(), input.repository_id);
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
  insertLocalWorkspace({
    id: workspaceId,
    repository_id: input.repository_id,
    slug,
    title: input.pr_title || null,
    git_branch: branchName,
    git_source_branch: sourceBranch,
    git_target_branch: input.target_branch || repo.git_default_branch || "main",
    pr_url: input.pr_url || null,
    pr_number: input.pr_number || null,
    first_session_id: firstSessionId,
    started_by:
      options.startedBy && options.startedBy.kind !== "person"
        ? JSON.stringify(options.startedBy)
        : null,
  });
  try {
    void initializeWorkspace({
      workspaceId,
      repoRootPath: rootPath,
      workspacePath: path.join(rootPath, ".deus", slug),
      branchName,
      sourceBranch,
      repoOriginUrl: repo.git_origin_url,
    });
  } finally {
    invalidate(["workspaces"]);
  }
  return { workspaceId, firstSessionId };
}

export function retryWorkspaceInit(workspaceId: string) {
  return changeWorkspaceState(workspaceId, async () => {
    const row = claimLocalRetry(workspaceId);
    void initializeWorkspace({
      workspaceId,
      repoRootPath: row.root_path,
      workspacePath: computeWorkspacePath(row),
      branchName: row.git_branch,
      sourceBranch:
        row.git_source_branch ?? row.git_target_branch ?? row.git_default_branch ?? "main",
      repoOriginUrl: row.git_origin_url,
    });
  });
}

/**
 * At startup: nothing is starting a workspace yet, so a row that says one is
 * being started was abandoned by the process before this one. Fail it, with
 * the folder and branch it may have half made, so it can be retried or deleted
 * instead of spinning forever. A setup script died with that process as well.
 *
 * A cloud workspace with a session is left alone: its computer is provisioned
 * by the platform, which reports through the session's channel.
 */
export async function failInterruptedWorkspaces(): Promise<number> {
  for (const row of runningSetups()) {
    setSetupStatus(row.id, "failed", { message: SETUP_INTERRUPTED });
  }
  const results = await Promise.allSettled(
    interruptedStarts().map(async (row) => {
      const cloud = row.kind === "cloud";
      const fail = () =>
        failInterruptedStart(row.id, row.init_stage ?? "fetch", {
          message: cloud
            ? "Deus closed before the cloud computer was ready."
            : "Deus closed before this workspace was ready.",
          detail: null,
        });
      if (cloud || !row.root_path || !row.git_branch || !OWNS_WORKTREE.has(row.init_stage ?? ""))
        return fail();
      const { root_path, git_branch } = row;
      return changeWorkspaceState(row.id, async () => {
        await removeWorktree(root_path, computeWorkspacePath(row), git_branch).catch((err) =>
          console.warn(`[WORKSPACE] Could not remove what ${row.id} left behind:`, err)
        );
        return !processGroupsStopped() && fail();
      });
    })
  );
  for (const result of results) {
    if (result.status === "rejected")
      console.warn("[WORKSPACE] Could not recover an interrupted start:", result.reason);
  }
  return results.filter((result) => result.status === "fulfilled" && result.value).length;
}
