import type { Workspace, RepoGroup, FileChange } from "@/shared/types";

export type ChangeStatus = "added" | "modified" | "deleted";

export function getChangeStatus(change: FileChange): ChangeStatus {
  if (change.additions > 0 && change.deletions === 0) return "added";
  if (change.deletions > 0 && change.additions === 0) return "deleted";
  return "modified";
}

export const STATUS_BG: Record<ChangeStatus, string> = {
  added: "bg-success",
  modified: "bg-warning",
  deleted: "bg-destructive",
};

export function fileChangePath(fc: FileChange): string {
  return fc.file || fc.file_path || "";
}

/**
 * Create an optimistic (placeholder) Workspace object for instant UI feedback
 * while the backend creates the real workspace asynchronously.
 *
 * Used in:
 * - useRepoActions.createAndSelectWorkspace() (quick "+" button flow)
 * - useRepoActions.handleOpenProject() (native folder dialog flow)
 * - useRepoActions.handleCloneRepository() (git clone flow)
 * - useCreateWorkspace() onMutate (React Query optimistic update)
 */
export function createOptimisticWorkspace(repoId: string, repoName: string): Workspace {
  return {
    id: `optimistic-${Date.now()}`,
    repository_id: repoId,
    slug: "",
    title: null,
    git_branch: null,
    git_target_branch: null,
    state: "initializing",
    status: "in-progress",
    current_session_id: null,
    session_status: null,
    session_error_category: null,
    session_error_message: null,
    latest_message_sent_at: null,
    init_stage: null,
    setup_status: "none",
    error_message: null,
    updated_at: new Date().toISOString(),
    repo_name: repoName,
    root_path: "",
    workspace_path: "",
  };
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

  return result;
}
