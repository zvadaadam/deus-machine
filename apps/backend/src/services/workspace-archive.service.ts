import { getWorkspaceRaw } from "../db";
import { getDatabase } from "../lib/database";
import { stopAppsForWorkspace } from "./aap";
import {
  pauseCloudWorkspace,
  wakeCloudWorkspaceWithFeedback,
} from "./cloud-workspace-init.service";
import { invalidate } from "./query-engine";
import { autoProgressStatus } from "./workspace-status.service";

/** Both HTTP and WS archive the same way. Cloud archive preserves its recovery data. */
async function performArchive(workspaceId: string): Promise<void> {
  const db = getDatabase();
  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  if (workspace.kind === "cloud" && workspace.provider_workspace_id) {
    // Confirm suspension before advertising the workspace as closed.
    await pauseCloudWorkspace(workspace.provider_workspace_id);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopAppsForWorkspace(workspaceId).catch((err) => {
        console.warn(`[Workspace] app cleanup failed during archive ${workspaceId}`, err);
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
  autoProgressStatus(workspaceId, "done", { force: true });
}

// Serialize archive/unarchive for one workspace so a slow pause cannot overwrite
// an unarchive that the user requested while it was in flight.
const changes = new Map<string, Promise<void>>();

function changeArchive(workspaceId: string, change: () => Promise<void>): Promise<void> {
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

export function archiveWorkspace(workspaceId: string): Promise<void> {
  return changeArchive(workspaceId, () => performArchive(workspaceId));
}

export function unarchiveWorkspace(workspaceId: string): Promise<void> {
  return changeArchive(workspaceId, async () => {
    const db = getDatabase();
    const workspace = getWorkspaceRaw(db, workspaceId);
    if (!workspace) throw new Error("Workspace not found");
    if (
      workspace.state === "archived" &&
      workspace.kind === "cloud" &&
      workspace.provider_workspace_id
    ) {
      // Open the projection before waking: a running/provisioning event may
      // arrive before Resume returns, and the driver ignores archived rows.
      db.prepare("UPDATE workspaces SET state = 'ready' WHERE id = ?").run(workspaceId);
      try {
        const result = await wakeCloudWorkspaceWithFeedback({
          ...workspace,
          provider_workspace_id: workspace.provider_workspace_id,
        });
        if (!result.ok) throw new Error("Could not wake the cloud machine. Try again.");
      } catch (err) {
        db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(workspaceId);
        invalidate(["workspaces", "stats"], {});
        throw err;
      }
      // Wake and its session channel own the current runtime projection.
      return;
    }
    db.prepare("UPDATE workspaces SET state = 'ready' WHERE id = ?").run(workspaceId);
  });
}
