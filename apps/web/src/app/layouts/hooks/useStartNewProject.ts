/**
 * Start New Project Hook — manages the "create from scratch" flow.
 *
 * Parallel to useCloneRepo: owns modal state, generation counter,
 * and multi-phase orchestration (git init → register → Home, with the project chosen).
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
  /** The project is registered: where the user goes next. */
  onAdded: (repo: Repository) => void;
}

export function useStartNewProject({ addRepoOrUseExisting, onAdded }: UseStartNewProjectOptions) {
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
   * Flow: gitInit → register repo → Home, with the project chosen.
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

      // Close modal
      resetStartNewState();
      onAdded(repo);

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
