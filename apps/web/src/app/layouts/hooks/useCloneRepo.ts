/**
 * Clone Repository Hook — manages the GitHub clone flow.
 *
 * Extracted from useRepoActions to keep each async flow isolated.
 *
 * Owns:
 * - Clone modal state (show, cloning, error, status)
 * - Generation counter for staleness detection
 * - Multi-phase clone orchestration (git clone → register → create workspace)
 */

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import type { Repository } from "@/features/repository/types";
import { native } from "@/platform";
import { extractRepoNameFromUrl } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import { sendCommand, connect, isConnected } from "@/platform/ws";

interface UseCloneRepoOptions {
  addRepoOrUseExisting: (path: string) => Promise<Repository>;
  createWorkspaceAndSelect: (repoId: string) => Promise<void>;
}

export function useCloneRepo({
  addRepoOrUseExisting,
  createWorkspaceAndSelect,
}: UseCloneRepoOptions) {
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
        if (isStale()) return;
        cloneTarget = `${home}/Developer/${repoName}`;
      } else if (!targetPath.endsWith(repoName) && !targetPath.endsWith(`${repoName}/`)) {
        cloneTarget = `${targetPath}/${repoName}`;
      }

      // Ensure WS is connected before starting
      if (!isConnected()) {
        await connect();
        if (isStale()) return;
      }

      // Phase 1: Git clone via WS command (5min timeout — large repos take a while)
      if (isStale()) return;
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

      // Phase 3: Create workspace
      setCloneStatus("Setting up workspace...");
      await createWorkspaceAndSelect(repo.id);
      if (isStale()) return;

      // Close modal
      resetCloneState();
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

  return {
    showCloneModal,
    setShowCloneModal,
    cloning,
    cloneError,
    cloneStatus,
    closeCloneModal,
    handleCloneRepository,
    clearCloneError: () => setCloneError(null),
  };
}
