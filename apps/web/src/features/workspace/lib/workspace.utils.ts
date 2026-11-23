import type { Workspace, RepoGroup, FileChange } from "@/shared/types";
import type { FileChangeStatus } from "@shared/types/workspace";

export const STATUS_BG: Record<FileChangeStatus, string> = {
  added: "bg-success",
  modified: "bg-warning",
  deleted: "bg-destructive",
  renamed: "bg-warning",
};

export function fileChangeLabel({ file, status, previous_path }: FileChange): string {
  return previous_path ? `${file} (${status} from ${previous_path})` : `${file} (${status})`;
}

/**
 * Merge a workspace delta (q:delta) into the existing RepoGroup[] cache.
 * Replaces matching workspaces by ID within their repo group, or appends if new.
 * Used by useQuerySubscription's mergeDelta option.
 */
export function mergeWorkspaceDelta(
  old: unknown,
  upserted?: unknown[],
  removed?: string[]
): unknown {
  if (!Array.isArray(old)) return old;
  const groups = old as RepoGroup[];
  if (!upserted && !removed) return old;

  let result = groups.map((g) => ({ ...g, workspaces: [...g.workspaces] }));

  if (removed?.length) {
    const removeSet = new Set(removed);
    result = result.map((g) => ({
      ...g,
      workspaces: g.workspaces.filter((w) => !removeSet.has(w.id)),
    }));
  }

  if (upserted?.length) {
    for (const item of upserted) {
      const ws = item as Workspace;
      const group = result.find((g) => g.repo_id === ws.repository_id);
      if (!group) continue;
      const idx = group.workspaces.findIndex((w) => w.id === ws.id);
      if (idx >= 0) {
        group.workspaces[idx] = ws;
      } else {
        group.workspaces.push(ws);
      }
    }
  }

  // Match the snapshot query's updated_at DESC order after an upsert changes it.
  return result.map((group) => ({
    ...group,
    workspaces: group.workspaces.sort((a, b) =>
      a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0
    ),
  }));
}
