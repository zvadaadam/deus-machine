import { GitSyncSummarySchema, type SessionSnapshotEvent } from "@deus-hq/api";

/** The last observed Git backup result for this chat, independently of agent success. */
export interface CloudGitSave {
  cloud_git_sync_at: number;
  cloud_git_error: string | null;
}

export function readCloudGitSave(receipt: unknown, timestamp: unknown): CloudGitSave | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
  const parsed = GitSyncSummarySchema.safeParse(receipt);
  if (!parsed.success) return;
  const { error, conflict, pushed, sha } = parsed.data;
  if (error || conflict) {
    return {
      cloud_git_sync_at: timestamp,
      cloud_git_error: error || "Git backup could not resolve a conflict with the remote.",
    };
  }
  // A WIP no-op still confirms its SHA against origin. A local commit or a
  // receipt without either acknowledgment is not evidence that work left the VM.
  if (pushed || sha) return { cloud_git_sync_at: timestamp, cloud_git_error: null };
  return undefined;
}

export function cloudGitSaveFromSnapshot(snapshot: SessionSnapshotEvent): CloudGitSave | undefined {
  let latest: CloudGitSave | undefined;
  for (const turn of snapshot.state.turns ?? []) {
    if (turn.turnId === snapshot.state.currentTurnId) continue;
    const save = readCloudGitSave(turn.gitSync, turn.endedAt);
    if (save && (!latest || save.cloud_git_sync_at > latest.cloud_git_sync_at)) latest = save;
  }
  return latest;
}
