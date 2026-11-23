import type { RepoGroup, Workspace } from "@shared/types/workspace";
import type { RepositoryWithCountsRow, WorkspaceWithDetailsRow } from "../db";
import { computeWorkspacePath } from "../middleware/workspace-loader";

/** A workspace row as clients read it: its folder resolved, its repository named. */
export function toWorkspace(row: WorkspaceWithDetailsRow): Workspace {
  return {
    ...row,
    repo_name: row.repo_name ?? "Unknown",
    root_path: row.root_path ?? "",
    git_default_branch: row.git_default_branch ?? undefined,
    workspace_path: computeWorkspacePath(row),
  };
}

export function groupWorkspacesByRepo(
  workspaces: WorkspaceWithDetailsRow[],
  allRepos: RepositoryWithCountsRow[]
): RepoGroup[] {
  const grouped: Record<string, RepoGroup> = {};

  for (const workspace of workspaces) {
    const repoId = workspace.repository_id || "unknown";
    if (!grouped[repoId]) {
      grouped[repoId] = {
        repo_id: repoId,
        repo_name: workspace.repo_name || "Unknown",
        sort_order: workspace.repo_sort_order ?? 999,
        git_origin_url: workspace.git_origin_url ?? null,
        has_folder: !!workspace.root_path,
        workspaces: [],
      };
    }
    grouped[repoId].workspaces.push(toWorkspace(workspace));
  }

  for (const repo of allRepos) {
    if (!grouped[repo.id]) {
      grouped[repo.id] = {
        repo_id: repo.id,
        repo_name: repo.name,
        sort_order: repo.sort_order ?? 999,
        git_origin_url: repo.git_origin_url ?? null,
        has_folder: !!repo.root_path,
        workspaces: [],
      };
    }
    grouped[repo.id].archived_count = repo.archived_count;
    if (repo.total_count === repo.archived_count) {
      grouped[repo.id].removal = repo.cloud_count ? "cloud" : "offered";
    }
  }

  return Object.values(grouped).sort((a, b) => a.sort_order - b.sort_order);
}
