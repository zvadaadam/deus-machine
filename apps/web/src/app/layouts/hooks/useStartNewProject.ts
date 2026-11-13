/**
 * Start New Project Hook — manages the "create from scratch" flow.
 *
 * Parallel to useCloneRepo: owns modal state, generation counter,
 * and multi-phase orchestration (git init → register → create workspace).
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";
import type { Repository } from "@/features/repository/types";
import { api } from "@shared/api";
import { getErrorMessage } from "@shared/lib/errors";
import { getRuntimeClient } from "@/platform/ws";

export interface StartNewProjectTemplate {
  type: "empty" | "github";
  url?: string;
}

interface UseStartNewProjectOptions {
  addRepoOrUseExisting: (path: string) => Promise<Repository>;
  createWorkspaceAndSelect: (repoId: string) => Promise<void>;
}

export function useStartNewProject({
  addRepoOrUseExisting,
  createWorkspaceAndSelect,
}: UseStartNewProjectOptions) {
  const [showStartNewModal, setShowStartNewModal] = useState(false);
  const [startingNew, setStartingNew] = useState(false);
  const [startNewError, setStartNewError] = useState<string | null>(null);
  const [startNewStatus, setStartNewStatus] = useState<string | null>(null);

  // Generation counter: prevents stale invocations from mutating state.
  const startNewGenerationRef = useRef(0);
  useEffect(
    () => () => {
      startNewGenerationRef.current++;
    },
    []
  );

  /** Reset all modal state to idle. */
  function resetStartNewState() {
    setShowStartNewModal(false);
    setStartNewError(null);
    setStartNewStatus(null);
    setStartingNew(false);
  }

  /**
   * Create a new project from scratch with staleness detection.
   * Flow: gitInit → register repo → create workspace → select it.
   */
  async function handleStartNewProject(
    projectName: string,
    targetPath: string,
    template?: StartNewProjectTemplate
  ) {
    const generation = ++startNewGenerationRef.current;
    const runtime = getRuntimeClient();
    const isStale = () =>
      generation !== startNewGenerationRef.current ||
      runtime.getState() === "disposed" ||
      runtime.getState() === "revoked";

    setStartingNew(true);
    setStartNewError(null);
    setStartNewStatus(null);
    try {
      if (!projectName.trim()) {
        setStartNewError("Project name is required");
        setStartingNew(false);
        return;
      }

      // Ensure WS is connected before starting
      if (!runtime.isConnected()) {
        await runtime.connect();
        if (isStale()) return;
      }

      // Phase 1: Create the project (2min timeout — a template clone and
      // creating the GitHub repository can take a bit). Asked of the runtime
      // this flow started on, not whichever is selected by then.
      if (isStale()) return;
      const { githubUrl } = await runtime.call(
        api.gitInit,
        {
          projectName: projectName.trim(),
          targetPath,
          ...(template ? { templateType: template.type, templateUrl: template.url } : {}),
        },
        { timeoutMs: 120_000 }
      );
      if (isStale()) return;

      // Phase 2: Register repository
      setStartNewStatus("Adding repository...");
      const repo = await addRepoOrUseExisting(targetPath);
      if (isStale()) return;

      // Phase 3: Create worktree workspace (standard flow — same as cloned repos)
      setStartNewStatus("Setting up workspace...");
      await createWorkspaceAndSelect(repo.id);
      if (isStale()) return;

      // Close modal
      resetStartNewState();

      if (githubUrl) {
        toast.success(`"${repo.name}" created`, {
          action: {
            label: "View on GitHub",
            onClick: () => window.open(githubUrl, "_blank"),
          },
        });
      } else {
        toast.success(`"${repo.name}" created`);
      }
    } catch (error) {
      if (!isStale()) {
        console.error("Error creating project:", error);
        setStartNewError(getErrorMessage(error));
        setStartNewStatus(null);
      }
    } finally {
      if (!isStale()) {
        setStartingNew(false);
      }
    }
  }

  /** Close modal and cancel any in-flight operation. */
  const closeStartNewModal = useCallback(() => {
    startNewGenerationRef.current++;
    resetStartNewState();
  }, []);

  return {
    showStartNewModal,
    setShowStartNewModal,
    startingNew,
    startNewError,
    startNewStatus,
    closeStartNewModal,
    handleStartNewProject,
    clearStartNewError: () => setStartNewError(null),
  };
}
