/**
 * Repository Actions Hook — repo registration, workspace creation, and git clone.
 *
 * Extracted from MainLayout to keep the layout component focused on
 * orchestrating sidebar/content panels and mounting modals.
 *
 * Owns all state and logic for:
 * - Opening a local project (native dialog + addRepo + auto-create workspace)
 * - Cloning a GitHub repo (validate URL, git clone, register, create workspace)
 * - Creating workspaces from the new-workspace modal
 * - 409 conflict handling when registering a repo that already exists
 * - Generation counter to prevent stale clone invocations from mutating state
 */

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import type { Repository } from "@/features/repository/types";
import { useCreateWorkspace } from "@/features/workspace/api";
import { useAddRepo } from "@/features/repository/api";
import { useSidebarStore } from "@/features/sidebar/store";
import { native } from "@/platform";
import { capabilities } from "@/platform/capabilities";
import { extractRepoNameFromUrl } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import { sendCommand, connect, isConnected } from "@/platform/ws";

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
  // Mutations
  const createWorkspaceMutation = useCreateWorkspace();
  const addRepoMutation = useAddRepo();
  const expandRepo = useSidebarStore((s) => s.expandRepo);

  // New-workspace modal state
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [creating, setCreating] = useState(false);

  // Clone modal state
  const [cloning, setCloning] = useState(false);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneStatus, setCloneStatus] = useState<string | null>(null);

  // Generation counter: prevents stale clone invocations from mutating state.
  // Each call to handleCloneRepository captures its generation; if the counter
  // advances (via close or a new clone), earlier invocations bail out.
  const cloneGenerationRef = useRef(0);

  /** Reset all clone modal state to idle. */
  function resetCloneState() {
    setShowCloneModal(false);
    setCloneError(null);
    setCloneStatus(null);
    setCloning(false);
  }

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

  /** Create a workspace for the given repo and select it. */
  const createAndSelectWorkspace = useCallback(
    async (repoId: string) => {
      setCreating(true);
      try {
        const workspace = await createWorkspaceMutation.mutateAsync(repoId);
        selectWorkspace(workspace.id);
        expandRepo(workspace.repository_id);
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

  /** Open a local project via native file dialog. */
  async function handleOpenProject() {
    if (!capabilities.nativeFolderPicker) return;
    const folderPath = await native.dialog.pickFolder();
    if (!folderPath) return;
    const folderName = folderPath.split("/").pop() || folderPath;
    const toastId = toast.loading(`Adding "${folderName}"…`);

    try {
      const repo = await addRepoOrUseExisting(folderPath);
      const workspace = await createWorkspaceMutation.mutateAsync(repo.id);
      selectWorkspace(workspace.id);
      expandRepo(workspace.repository_id);
      toast.success(`"${repo.name}" ready`, { id: toastId });
    } catch (error) {
      console.error("Error adding repository:", error);
      toast.error(getErrorMessage(error), { id: toastId });
    }
  }

  /**
   * Clone a GitHub repository with staleness detection.
   * All steps go through WS commands/mutations so it works in both
   * desktop (local backend) and web (relay) modes.
   */
  async function handleCloneRepository(githubUrl: string, targetPath: string) {
    // Advance generation so any in-flight clone from a previous invocation bails out.
    const generation = ++cloneGenerationRef.current;
    const isStale = () => generation !== cloneGenerationRef.current;

    setCloning(true);
    setCloneError(null);
    setCloneStatus(null);
    try {
      const repoName = extractRepoNameFromUrl(githubUrl);
      if (!repoName) {
        setCloneError("Invalid repository URL");
        setCloning(false);
        return;
      }

      let cloneTarget = targetPath;
      if (!cloneTarget) {
        const home = await native.dialog.getHomeDir();
        cloneTarget = `${home}/Developer/${repoName}`;
      } else if (!targetPath.endsWith(repoName) && !targetPath.endsWith(`${repoName}/`)) {
        cloneTarget = `${targetPath}/${repoName}`;
      }

      // Ensure WS is connected before starting
      if (!isConnected()) await connect();

      // Phase 1: Git clone via WS command (5min timeout — large repos take a while)
      const cloneAck = await sendCommand(
        "git:clone",
        { url: githubUrl, targetPath: cloneTarget },
        300_000
      );
      if (!cloneAck.accepted) {
        throw new Error(cloneAck.error || "Clone failed");
      }
      if (isStale()) return;

      // Phase 2: Register repository via WS mutation
      setCloneStatus("Adding repository...");
      const repo = await addRepoOrUseExisting(cloneTarget);
      if (isStale()) return;

      // Phase 3: Create workspace via WS command
      setCloneStatus("Setting up workspace...");
      const workspace = await createWorkspaceMutation.mutateAsync(repo.id);
      if (isStale()) return;

      // Close modal and select workspace
      resetCloneState();
      selectWorkspace(workspace.id);
      expandRepo(workspace.repository_id);
      toast.success(`"${repo.name}" cloned`);
    } catch (error) {
      if (!isStale()) {
        console.error("Error cloning repository:", error);
        setCloneError(getErrorMessage(error));
        setCloneStatus(null);
      }
    } finally {
      if (!isStale()) {
        setCloning(false);
      }
    }
  }

  /** Close clone modal and cancel any in-flight clone. */
  const closeCloneModal = useCallback(() => {
    cloneGenerationRef.current++;
    resetCloneState();
  }, []);

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

    // Clone modal state
    showCloneModal,
    setShowCloneModal,
    cloning,
    cloneError,
    cloneStatus,
    closeCloneModal,
    handleCloneRepository,

    // Open project (native dialog)
    handleOpenProject,

    // For clearing clone errors from the modal
    clearCloneError: () => setCloneError(null),
  };
}
