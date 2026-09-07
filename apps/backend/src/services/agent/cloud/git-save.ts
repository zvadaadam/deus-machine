import type { CloudGitSave } from "@shared/cloud-git-save";
import { getDatabase } from "../../../lib/database";

/** Snapshot replay and live receipts share one monotonic, durable projection. */
export function persistCloudGitSave(sessionId: string, save: CloudGitSave): boolean {
  return (
    getDatabase()
      .prepare(
        `UPDATE sessions SET cloud_git_sync_at = ?, cloud_git_error = ?
         WHERE id = ? AND (cloud_git_sync_at IS NULL OR cloud_git_sync_at < ?)`
      )
      .run(save.cloud_git_sync_at, save.cloud_git_error, sessionId, save.cloud_git_sync_at)
      .changes > 0
  );
}
