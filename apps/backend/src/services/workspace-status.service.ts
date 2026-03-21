import { STICKY_STATUSES, STATUS_RANK, type WorkspaceStatus } from "@shared/enums";
import { getDatabase } from "../lib/database";
import { getWorkspaceRaw } from "../db";

/**
 * Auto-progress a workspace's workflow status.
 *
 * Rules:
 * - Sticky states (backlog, canceled) resist auto-progression unless forced
 * - Won't regress (in-review won't go back to in-progress)
 * - Force mode (used by archive) overrides both guards
 *
 * IMPORTANT: Does NOT call invalidate(). The caller is responsible for
 * invalidation after its own DB writes. This prevents double WS pushes.
 */
export function autoProgressStatus(
  workspaceId: string,
  target: WorkspaceStatus,
  opts: { force?: boolean } = {}
): boolean {
  const db = getDatabase();
  const ws = getWorkspaceRaw(db, workspaceId);
  if (!ws) return false;

  const current = ws.status as WorkspaceStatus;

  if (!opts.force) {
    // Sticky states resist auto-progression (backlog, canceled)
    if (STICKY_STATUSES.has(current)) return false;
    // Don't regress (in-review → in-progress is wrong)
    if (STATUS_RANK[target] <= STATUS_RANK[current]) return false;
  }

  db.prepare("UPDATE workspaces SET status = ? WHERE id = ?").run(target, workspaceId);
  return true;
}

/**
 * Explicitly set workspace status (user override). No sticky/flow guards.
 * Used by the updateWorkspaceStatus mutation.
 */
export function setWorkspaceStatus(workspaceId: string, status: WorkspaceStatus): void {
  const db = getDatabase();
  db.prepare("UPDATE workspaces SET status = ? WHERE id = ?").run(status, workspaceId);
}
