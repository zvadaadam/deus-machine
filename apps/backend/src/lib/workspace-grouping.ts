import type { WorkspaceWithDetailsRow } from "../db";
import { computeWorkspacePath } from "../middleware/workspace-loader";

export interface RepoGroup {
  repo_id: string;
  repo_name: string;
  sort_order: number;
  git_origin_url?: string | null;
  workspaces: unknown[];
}

export function groupWorkspacesByRepo(
  workspaces: WorkspaceWithDetailsRow[],
  allRepos: { id: string; name: string; sort_order: number; git_origin_url: string | null }[]
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
        workspaces: [],
      };
    }
    grouped[repoId].workspaces.push({
      ...workspace,
      workspace_path: computeWorkspacePath(workspace),
    });
  }

  for (const repo of allRepos) {
    if (!grouped[repo.id]) {
      grouped[repo.id] = {
        repo_id: repo.id,
        repo_name: repo.name,
        sort_order: repo.sort_order ?? 999,
        git_origin_url: repo.git_origin_url ?? null,
        workspaces: [],
      };
    }
  }

  return Object.values(grouped).sort((a, b) => a.sort_order - b.sort_order);
}
