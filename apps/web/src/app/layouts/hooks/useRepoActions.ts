/**
 * Repository Actions Hook — thin coordinator for repo-related flows.
 *
 * Delegates each async flow to its own hook:
 * - useCloneRepo — GitHub clone modal + multi-phase clone
 * - useStartNewProject — create-from-scratch modal + git init
 *
 * Keeps shared logic here:
 * - addRepoOrUseExisting (409 conflict handling)
 * - createAndSelectWorkspace (core workspace creation)
 * - handleOpenProject (simple native dialog flow)
 * - handleNewWorkspace / handleNewWorkspaceFromGitHub (workspace modal)
 */

import { useState, useCallback } from "react";
import { toast } from "sonner";
import type { Repository } from "@/features/repository/types";
import { useCreateWorkspace } from "@/features/workspace/api";
import { useAddRepo } from "@/features/repository/api";
import { useSidebarStore } from "@/features/sidebar/store";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { getErrorMessage } from "@shared/lib/errors";
import { useCloneRepo } from "./useCloneRepo";
import { useStartNewProject } from "./useStartNewProject";

interface UseRepoActionsOptions {
  selectWorkspace: (id: string | null) => void;
  openNewWorkspaceModal: () => void;
  closeNewWorkspaceModal: () => void;
}

export function useRepoActions({
  selectWorkspace,
  openNewWorkspaceModal,
  closeNewWorkspaceModal,
}: UseRepoActionsOptions) {
  // Shared mutations
  const createWorkspaceMutation = useCreateWorkspace();
  const addRepoMutation = useAddRepo();
  const expandRepo = useSidebarStore((s) => s.expandRepo);

  // New-workspace modal state (used by NewWorkspaceModal)
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [creating, setCreating] = useState(false);

  // ── Shared utilities ─────────────────────────────────────────

  /** Add a repo, falling back to the existing one on 409 conflict. */
  async function addRepoOrUseExisting(path: string): Promise<Repository> {
    try {
      return await addRepoMutation.mutateAsync(path);
    } catch (err) {
      const addError = err as { status?: number; details?: { details?: Repository } };
      const existingRepo = addError?.details?.details;
      if (addError?.status === 409 && existingRepo?.id) {
        return existingRepo;
      }
      throw err;
    }
  }

  /** Create a workspace for the given repo, select it, and expand the sidebar. */
  async function createWorkspaceAndSelect(repoId: string) {
    const workspace = await createWorkspaceMutation.mutateAsync(repoId);
    selectWorkspace(workspace.id);
    expandRepo(workspace.repository_id);
  }

  // ── Clone flow ───────────────────────────────────────────────

  const clone = useCloneRepo({
    addRepoOrUseExisting,
    createWorkspaceAndSelect,
  });

  // ── Start new project flow ───────────────────────────────────

  const startNew = useStartNewProject({
    addRepoOrUseExisting,
    createWorkspaceAndSelect,
  });

  // ── Workspace creation ───────────────────────────────────────

  /** Create a workspace with loading state and error handling. */
  const createAndSelectWorkspace = useCallback(
    async (repoId: string) => {
      setCreating(true);
      try {
        await createWorkspaceAndSelect(repoId);
      } catch (error) {
        selectWorkspace(null);
        console.error("Error creating workspace:", error);
        toast.error(getErrorMessage(error));
      } finally {
        setCreating(false);
      }
    },
    [createWorkspaceMutation, selectWorkspace, expandRepo]
  );

  /** Create workspace from the new-workspace modal (validates repo selection). */
  async function createWorkspaceFromModal() {
    if (!selectedRepoId) {
      toast.error("Please select a repository");
      return;
    }
    const repoIdToCreate = selectedRepoId;
    setSelectedRepoId("");
    closeNewWorkspaceModal();
    await createAndSelectWorkspace(repoIdToCreate);
  }

  /** Handle "New Workspace" — if repoId is provided, create directly; otherwise open modal. */
  const handleNewWorkspace = useCallback(
    async (repoId?: string) => {
      if (repoId) {
        await createAndSelectWorkspace(repoId);
        return;
      }
      openNewWorkspaceModal();
    },
    [openNewWorkspaceModal, createAndSelectWorkspace]
  );

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
      await createWorkspaceAndSelect(repo.id);
      toast.success(`"${repo.name}" ready`, { id: toastId });
    } catch (error) {
      console.error("Error adding repository:", error);
      toast.error(getErrorMessage(error), { id: toastId });
    }
  }

  // ── GitHub workspace creation ────────────────────────────────

  /** Create workspace from a GitHub PR or branch (extended params). */
  const handleNewWorkspaceFromGitHub = useCallback(
    async (params: {
      repositoryId: string;
      source_branch: string;
      pr_number?: number;
      pr_url?: string;
      pr_title?: string;
      target_branch?: string;
    }) => {
      setCreating(true);
      try {
        const workspace = await createWorkspaceMutation.mutateAsync(params);
        selectWorkspace(workspace.id);
        expandRepo(workspace.repository_id);
      } catch (error) {
        selectWorkspace(null);
        console.error("Failed to create workspace from GitHub:", error);
        toast.error(getErrorMessage(error));
      } finally {
        setCreating(false);
      }
    },
    [createWorkspaceMutation, selectWorkspace, expandRepo]
  );

  return {
    // New-workspace modal state
    selectedRepoId,
    setSelectedRepoId,
    creating,
    createWorkspaceFromModal,
    handleNewWorkspace,
    handleNewWorkspaceFromGitHub,

    // Clone flow (delegated to useCloneRepo)
    ...clone,

    // Start new project flow (delegated to useStartNewProject)
    ...startNew,

    // Open project (native dialog)
    handleOpenProject,
  };
}
