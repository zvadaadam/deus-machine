/**
 * Workspace Actions Hook — PR bridge, archive, retry, and manifest tasks.
 *
 * Extracts all workspace-level action handlers from MainContent, keeping
 * the layout component focused on panel geometry. This hook manages:
 * - PR handler bridge (ChatArea sets handlers, WorkspaceHeader consumes them)
 * - Archive, retry setup, view setup logs
 * - Manifest task discovery and execution
 * - Target branch selection for PR creation
 */

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  useArchiveWorkspace,
  useRetrySetup,
  useManifestTasks,
} from "@/features/workspace/api/workspace.queries";
import { WorkspaceService } from "@/features/workspace/api/workspace.service";
import { queueTerminalTask } from "@/features/terminal/store/terminalTaskStore";
import { simulatorStoreActions } from "@/features/simulator/store";
import { simulatorService } from "@/features/simulator/api/simulator.service";
import type { ContentTab } from "@/features/workspace/store";
import type { Workspace } from "@/shared/types";

interface UseWorkspaceActionsOptions {
  selectedWorkspace: Workspace | null;
  setContentTab: (tab: ContentTab) => void;
}

export function useWorkspaceActions({
  selectedWorkspace,
  setContentTab,
}: UseWorkspaceActionsOptions) {
  // PR handler bridge: ChatArea sets it, WorkspaceHeader consumes it.
  // Setter must be called as `setXxxHandler(() => handler)` — passing a
  // function directly causes React to invoke it as a state updater (see bf516c6).
  const [createPRHandler, setCreatePRHandler] = useState<(() => void) | null>(null);
  const [sendAgentMessageHandler, setSendAgentMessageHandler] = useState<
    ((text: string) => Promise<void>) | null
  >(null);

  // Target branch for PR creation/merge — synced from WorkspaceHeader's branch selector
  const [selectedTargetBranch, setSelectedTargetBranch] = useState<string>(
    selectedWorkspace?.git_default_branch ?? "main"
  );

  // Reset target branch when workspace changes (render-time pattern).
  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const prevWsIdRef = useRef(selectedWorkspaceId);

  if (prevWsIdRef.current !== selectedWorkspaceId) {
    prevWsIdRef.current = selectedWorkspaceId;
    setSelectedTargetBranch(selectedWorkspace?.git_default_branch ?? "main");
  }

  // --- PR actions ---

  const handleCreatePR = useCallback(() => {
    if (!createPRHandler) {
      toast.error("No active session available to create a PR.");
      return;
    }
    createPRHandler();
  }, [createPRHandler]);

  const handleSendAgentMessage = useCallback(
    (text: string) => {
      if (!sendAgentMessageHandler) {
        toast.error("No active session available.");
        return;
      }
      sendAgentMessageHandler(text);
    },
    [sendAgentMessageHandler]
  );

  // --- Archive & retry ---

  const { mutate: archiveWorkspace } = useArchiveWorkspace();
  const handleArchive = useCallback(() => {
    if (!selectedWorkspace) return;
    // Release simulator resources before archiving — the native session would
    // otherwise leak in the HashMap until app close (no lifecycle hook exists).
    const simSession = simulatorStoreActions.getSession(selectedWorkspace.id);
    if (simSession.phase !== "idle") {
      simulatorService.stopStreaming(selectedWorkspace.id).catch(() => {
        /* Expected: streaming may already be stopped or session may not exist */
      });
      simulatorStoreActions.clearWorkspaceSession(selectedWorkspace.id);
    }
    archiveWorkspace(selectedWorkspace.id);
  }, [selectedWorkspace, archiveWorkspace]);

  const { mutate: retrySetup } = useRetrySetup();
  const handleRetrySetup = useCallback(() => {
    if (!selectedWorkspace) return;
    retrySetup(selectedWorkspace.id);
  }, [selectedWorkspace, retrySetup]);

  const handleViewSetupLogs = useCallback(() => {
    if (!selectedWorkspace) return;
    WorkspaceService.fetchSetupLogs(selectedWorkspace.id)
      .then(({ logs }) => {
        if (!logs) {
          toast.error("No setup logs available.");
          return;
        }
        const blob = new Blob([logs], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(() => {
        toast.error("Failed to fetch setup logs.");
      });
  }, [selectedWorkspace]);

  // --- Manifest tasks (deus.json) ---

  const isWorkspaceReady = selectedWorkspace?.state === "ready";
  const { data: manifestData } = useManifestTasks(isWorkspaceReady ? selectedWorkspaceId : null);
  const manifestTasks = manifestData?.tasks;
  const hasManifest = manifestData?.manifest != null;

  const handleRunTask = useCallback(
    (taskName: string) => {
      if (!selectedWorkspace) return;
      WorkspaceService.runTask(selectedWorkspace.id, taskName)
        .then(({ command }) => {
          // Open a new terminal tab running the task command
          queueTerminalTask(taskName, command);
          // Switch to terminal tab (right panel is always visible now)
          setContentTab("terminal");
        })
        .catch((err) => {
          toast.error(
            `Failed to run task: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        });
    },
    [selectedWorkspace, setContentTab]
  );

  return {
    // PR handler bridge (ChatArea → WorkspaceHeader)
    createPRHandler,
    setCreatePRHandler,
    sendAgentMessageHandler,
    setSendAgentMessageHandler,
    // Target branch
    selectedTargetBranch,
    setSelectedTargetBranch,
    // Action handlers
    handleCreatePR,
    handleSendAgentMessage,
    handleArchive,
    handleRetrySetup,
    handleViewSetupLogs,
    // Manifest
    manifestTasks,
    hasManifest,
    handleRunTask,
  };
}
