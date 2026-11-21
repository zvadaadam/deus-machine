import type { Origin } from "@shared/types/workspace";
import { getWorkspaceRaw } from "../db";
import { getDatabase } from "../lib/database";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
  CloudChatError,
  pauseCloudWorkspace,
  wakeCloudWorkspaceWithFeedback,
} from "./cloud-workspace-init.service";
import {
  changeWorkspaceState,
  markArchived,
  markRestored,
  rollbackCloudRestore,
  queueCloudWake,
} from "./workspace-lifecycle";
import { stopWorkspaceSetup } from "./project-environment.service";
import { stopStream } from "./simulator-context";
import { autoProgressStatus } from "./workspace-status.service";

/**
 * Every caller archives the same way. Cloud archive preserves its recovery
 * data. `check`, when given, runs in the queue right before the update, with
 * no await between, and may refuse it (the operator's host re-reads its
 * archive eligibility there).
 */
export function archiveWorkspace(
  workspaceId: string,
  check?: () => void,
  by?: Origin | null
): Promise<void> {
  return changeWorkspaceState(workspaceId, async () => {
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

    const checkout = markArchived(db, workspaceId, check, by);
    try {
      stopStream(workspaceId);
      const stopped = stopWorkspaceSetup(workspaceId);
      autoProgressStatus(workspaceId, "done", { force: true });
      await stopped;
    } finally {
      await checkout;
    }
  });
}

export function wakeWorkspace(workspaceId: string) {
  return queueCloudWake(workspaceId, async (latest) => {
    const workspace = getWorkspaceRaw(getDatabase(), workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.kind !== "cloud" || !workspace.provider_workspace_id) {
      throw new ValidationError("Not a cloud workspace");
    }
    if (workspace.state === "archived") {
      throw new ValidationError("Workspace is archived — unarchive it first");
    }
    return wakeCloudWorkspaceWithFeedback(
      {
        ...workspace,
        provider_workspace_id: workspace.provider_workspace_id,
      },
      latest
    );
  });
}

export function unarchiveWorkspace(workspaceId: string): Promise<void> {
  return queueCloudWake(workspaceId, async (latest) => {
    const db = getDatabase();
    const workspace = markRestored(db, workspaceId);
    if (!workspace) return;
    if (workspace.kind === "cloud" && workspace.provider_workspace_id) {
      try {
        const result = await wakeCloudWorkspaceWithFeedback(
          {
            ...workspace,
            provider_workspace_id: workspace.provider_workspace_id,
          },
          latest
        );
        // A failed status refresh can still leave the computer serving.
        if (!result.ok && result.status !== "running") {
          throw new Error("Could not wake the cloud machine. Try again.");
        }
      } catch (err) {
        if (!latest() && !(err instanceof CloudChatError)) rollbackCloudRestore(db, workspaceId);
        throw err;
      }
    }
    if (getWorkspaceRaw(db, workspaceId)?.status === "done") {
      autoProgressStatus(workspaceId, "in-progress", { force: true });
    }
  });
}
