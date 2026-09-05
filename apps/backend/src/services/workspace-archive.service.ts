import { getWorkspaceRaw } from "../db";
import { getDatabase } from "../lib/database";
import { stopAppsForWorkspace } from "./aap";
import { pauseCloudWorkspace } from "./cloud-workspace-init.service";
import { autoProgressStatus } from "./workspace-status.service";

/** Both HTTP and WS archive the same way. Cloud archive preserves its recovery data. */
export async function archiveWorkspace(workspaceId: string): Promise<void> {
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
