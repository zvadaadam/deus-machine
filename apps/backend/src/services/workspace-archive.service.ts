import { getWorkspaceRaw } from "../db";
import { getDatabase } from "../lib/database";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
  pauseCloudWorkspace,
  wakeCloudWorkspaceWithFeedback,
} from "./cloud-workspace-init.service";
import { invalidate } from "./query-engine";
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

  check?.();
  db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
  const stopped = stopWorkspaceSetup(workspaceId);
  autoProgressStatus(workspaceId, "done", { force: true });
  await stopped;
}

// Archive, unarchive and explicit wake share one queue: a delayed Resume
// must finish before a later Pause can advertise the workspace as archived.
const changes = new Map<string, Promise<unknown>>();

function changeWorkspaceState<T>(workspaceId: string, change: () => Promise<T>): Promise<T> {
  const previous = changes.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(change);
  changes.set(workspaceId, next);
  void next
    .finally(() => {
      if (changes.get(workspaceId) === next) changes.delete(workspaceId);
    })
    .catch(() => {});
  return next;
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
    const workspace = getWorkspaceRaw(db, workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.state !== "archived") return;
    if (workspace.kind === "cloud" && workspace.provider_workspace_id) {
      // Open the projection before waking: a running/provisioning event may
      // arrive before Resume returns, and the driver ignores archived rows.
      db.prepare("UPDATE workspaces SET state = 'ready' WHERE id = ?").run(workspaceId);
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
        db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
        invalidate(["workspaces"], {});
        throw err;
      }
    } else {
      // With no chat it was archived before it finished starting.
      db.prepare(
        "UPDATE workspaces SET state = CASE WHEN current_session_id IS NULL THEN 'error' ELSE 'ready' END WHERE id = ?"
      ).run(workspaceId);
    }
    if (getWorkspaceRaw(db, workspaceId)?.status === "done") {
      autoProgressStatus(workspaceId, "in-progress", { force: true });
    }
  });
}
