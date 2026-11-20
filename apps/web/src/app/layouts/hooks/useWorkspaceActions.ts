/**
 * Workspace Actions Hook — PR bridge, archive, retry, and project commands.
 *
 * Extracts all workspace-level action handlers from MainContent, keeping
 * the layout component focused on panel geometry. This hook manages:
 * - PR handler bridge (ChatArea sets handlers, WorkspaceHeader consumes them)
 * - Archive, retry setup, view setup logs
 * - Project command discovery and execution
 * - Target branch selection for PR creation
 */

import { useState, useCallback } from "react";
import { toast } from "sonner";
import {
  useArchiveWorkspace,
  useProjectEnvironment,
} from "@/features/workspace/api/workspace.queries";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { queueTerminalTask } from "@/features/terminal/store/terminalTaskStore";
import { simulatorStoreActions } from "@/features/simulator/store";
import type { ContentTab } from "@/features/workspace/store";
import type { Workspace } from "@/shared/types";
import { prTargetBranch } from "@/features/workspace/lib/prState";
import { useSetupActions } from "@/features/workspace/hooks/useSetupActions";

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
  // Starts on the workspace's own target (the branch it came from), not the
  // project's default: they differ for a workspace started from another branch,
  // and the default may still be corrected after the workspace is selected.
  const workspaceTarget = prTargetBranch(selectedWorkspace);
  const [selectedTargetBranch, setSelectedTargetBranch] = useState<string>(workspaceTarget);

  // Reset when the workspace changes, or when what it targets becomes known
  // (a workspace selected before its row arrived; a corrected default branch).
  // Render-time pattern.
  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const targetKey = `${selectedWorkspaceId ?? ""}\u0000${workspaceTarget}`;
  const [prevTargetKey, setPrevTargetKey] = useState(targetKey);

  if (prevTargetKey !== targetKey) {
    setPrevTargetKey(targetKey);
    setSelectedTargetBranch(workspaceTarget);
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
      call(api.simStop, { workspaceId: selectedWorkspace.id }).catch(() => {
        /* Expected: streaming may already be stopped or session may not exist */
      });
      simulatorStoreActions.clearWorkspaceSession(selectedWorkspace.id);
    }
    archiveWorkspace(selectedWorkspace.id, {
      onError: (error) => toast.error(error.message),
    });
  }, [selectedWorkspace, archiveWorkspace]);

  const { retry: handleRetrySetup, viewLog: handleViewSetupLogs } =
    useSetupActions(selectedWorkspaceId);

  // --- Project environment commands ---

  const isWorkspaceReady = selectedWorkspace?.state === "ready";
  const environment = useProjectEnvironment(isWorkspaceReady ? selectedWorkspaceId : null);
  const environmentTasks = environment.isSuccess ? environment.data.tasks : undefined;

  const handleRunTask = useCallback(
    (taskName: string) => {
      if (!selectedWorkspace) return;
      call(api.runTask, { workspaceId: selectedWorkspace.id, taskName })
        .then(({ command }) => {
          // Open a new terminal tab running the task command (scoped to this
          // workspace so it can only run in its own repo)
          queueTerminalTask(selectedWorkspace.id, taskName, command);
          // Explicit navigation reveals the terminal if the workspace panel is hidden.
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
    // Project environment
    environmentTasks,
    handleRunTask,
  };
}
