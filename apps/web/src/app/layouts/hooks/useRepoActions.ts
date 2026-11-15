/**
 * Repository Actions Hook — thin coordinator for adding a project.
 *
 * Delegates each async flow to its own hook:
 * - useCloneRepo — GitHub clone modal + multi-phase clone
 * - useStartNewProject — create-from-scratch modal + git init
 *
 * Keeps shared logic here:
 * - addRepoOrUseExisting (409 conflict handling)
 * - handleOpenProject (simple native dialog flow)
 * - handleNewWorkspaceFromGitHub (a workspace on a pull request or branch)
 *
 * Every flow that adds a project ends the same way: Home, with the project
 * chosen, where the first message creates its first workspace.
 */

import { useCallback } from "react";
import { toast } from "sonner";
import type { Repository } from "@/features/repository/types";
import { useCreateWorkspace } from "@/features/workspace/api";
import { useAddRepo } from "@/features/repository/api";
import { useSidebarStore } from "@/features/sidebar/store";
import { openNewWorkspace } from "@/features/workspace/lib/newWorkspace";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { getErrorMessage } from "@shared/lib/errors";
import { useCloneRepo } from "./useCloneRepo";
import { useStartNewProject } from "./useStartNewProject";

interface UseRepoActionsOptions {
  selectWorkspace: (id: string | null) => void;
}

export function useRepoActions({ selectWorkspace }: UseRepoActionsOptions) {
  const createWorkspaceMutation = useCreateWorkspace();
  const addRepoMutation = useAddRepo();
  const expandRepo = useSidebarStore((s) => s.expandRepo);

  // ── Shared utilities ─────────────────────────────────────────

  /** Add a repo, falling back to the existing one on 409 conflict. */
  async function addRepoOrUseExisting(path: string): Promise<Repository> {
    try {
      return await addRepoMutation.mutateAsync(path);
    } catch (err) {
      const addError = err as { status?: number; details?: Repository };
      const existingRepo = addError?.details;
      if (addError?.status === 409 && existingRepo?.id) {
        return existingRepo;
      }
      throw err;
    }
  }

  /** A project was added: show Home with it chosen. */
  function startIn(repo: Repository) {
    expandRepo(repo.id);
    openNewWorkspace({ repoId: repo.id });
  }

  // ── Clone flow ───────────────────────────────────────────────

  const clone = useCloneRepo({ addRepoOrUseExisting, onAdded: startIn });

  // ── Start new project flow ───────────────────────────────────

  const startNew = useStartNewProject({ addRepoOrUseExisting, onAdded: startIn });

  // ── Open local project ───────────────────────────────────────

  /** Open a local project via native file dialog. */
  async function handleOpenProject() {
    if (!capabilities.nativeFolderPicker) return;
    const folderPath = await native.dialog.pickFolder();
    if (!folderPath) return;
    const folderName = folderPath.split("/").pop() || folderPath;
    const toastId = toast.loading(`Adding "${folderName}"…`);

    try {
      const repo = await addRepoOrUseExisting(folderPath);
      startIn(repo);
      toast.success(`"${repo.name}" added`, { id: toastId });
    } catch (error) {
      console.error("Error adding repository:", error);
      toast.error(getErrorMessage(error), { id: toastId });
    }
  }

  // ── GitHub workspace creation ────────────────────────────────

  /** Create a workspace on a pull request or branch: it has a subject already, so no prompt. */
  const handleNewWorkspaceFromGitHub = useCallback(
    async (params: {
      repositoryId: string;
      source_branch: string;
      pr_number?: number;
      pr_url?: string;
      pr_title?: string;
      target_branch?: string;
    }) => {
      try {
        const workspace = await createWorkspaceMutation.mutateAsync(params);
        selectWorkspace(workspace.id);
        expandRepo(workspace.repository_id);
      } catch (error) {
        selectWorkspace(null);
        console.error("Failed to create workspace from GitHub:", error);
        toast.error(getErrorMessage(error));
      }
    },
    [createWorkspaceMutation, selectWorkspace, expandRepo]
  );

  return {
    handleNewWorkspaceFromGitHub,

    // Clone flow (delegated to useCloneRepo)
    ...clone,

    // Start new project flow (delegated to useStartNewProject)
    ...startNew,

    // Open project (native dialog)
    handleOpenProject,
  };
}
