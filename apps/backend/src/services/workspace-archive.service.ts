import { getWorkspaceRaw } from "../db";
import { getDatabase } from "../lib/database";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
  pauseCloudWorkspace,
  wakeCloudWorkspaceWithFeedback,
} from "./cloud-workspace-init.service";
import {
  changeWorkspaceState,
  markArchived,
  markRestored,
  rollbackCloudRestore,
} from "./workspace-lifecycle";
import { stopWorkspaceSetup } from "./project-environment.service";
import { autoProgressStatus } from "./workspace-status.service";

/**
 * Every caller archives the same way. Cloud archive preserves its recovery
 * data. `check`, when given, runs in the queue right before the update, with
 * no await between, and may refuse it (the operator's host re-reads its
 * archive eligibility there).
 */
async function performArchive(workspaceId: string, check?: () => void): Promise<void> {
  const db = getDatabase();
  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new NotFoundError("Workspace not found");
  if (workspace.kind === "cloud" && workspace.provider_workspace_id) {
    // Confirm suspension before advertising the workspace as closed.
    await pauseCloudWorkspace({
      ...workspace,
      provider_workspace_id: workspace.provider_workspace_id,
    });
  }

  const checkout = markArchived(db, workspaceId, check);
  try {
    const stopped = stopWorkspaceSetup(workspaceId);
    autoProgressStatus(workspaceId, "done", { force: true });
    await stopped;
  } finally {
    await checkout;
  }
}

export function archiveWorkspace(workspaceId: string, check?: () => void): Promise<void> {
  return changeWorkspaceState(workspaceId, () => performArchive(workspaceId, check));
}

export function wakeWorkspace(workspaceId: string) {
  return changeWorkspaceState(workspaceId, async () => {
    const workspace = getWorkspaceRaw(getDatabase(), workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.kind !== "cloud" || !workspace.provider_workspace_id) {
      throw new ValidationError("Not a cloud workspace");
    }
    if (workspace.state === "archived") {
      throw new ValidationError("Workspace is archived — unarchive it first");
    }
    return wakeCloudWorkspaceWithFeedback({
      ...workspace,
      provider_workspace_id: workspace.provider_workspace_id,
    });
  });
}

export function unarchiveWorkspace(workspaceId: string): Promise<void> {
  return changeWorkspaceState(workspaceId, async () => {
    const db = getDatabase();
    const workspace = markRestored(db, workspaceId);
    if (!workspace) return;
    if (workspace.kind === "cloud" && workspace.provider_workspace_id) {
      try {
        const result = await wakeCloudWorkspaceWithFeedback({
          ...workspace,
          provider_workspace_id: workspace.provider_workspace_id,
        });
        // A failed status refresh can still leave the computer serving.
        if (!result.ok && result.status !== "running") {
          throw new Error("Could not wake the cloud machine. Try again.");
        }
      } catch (err) {
        rollbackCloudRestore(db, workspaceId);
        throw err;
      }
    }
    if (getWorkspaceRaw(db, workspaceId)?.status === "done") {
      autoProgressStatus(workspaceId, "in-progress", { force: true });
    }
  });
}
