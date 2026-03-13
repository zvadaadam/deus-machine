import type { Workspace } from "@/shared/types";

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
    current_session_id: null,
    session_status: null,
    model: null,
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
