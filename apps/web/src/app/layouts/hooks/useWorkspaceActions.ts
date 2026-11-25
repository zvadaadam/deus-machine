/**
 * Workspace Actions Hook — PR bridge and project commands.
 *
 * Extracts all workspace-level action handlers from MainContent, keeping
 * the layout component focused on panel geometry. This hook manages:
 * - PR handler bridge (ChatArea sets handlers, WorkspaceHeader consumes them)
 * - Project command discovery and execution
 * - Target branch selection for PR creation
 */

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useProjectEnvironment } from "@/features/workspace/api/workspace.queries";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { workspaceLayoutActions } from "@/features/workspace/store";
import type { Workspace } from "@/shared/types";
import { prTargetBranch } from "@/features/workspace/lib/prState";

interface UseWorkspaceActionsOptions {
  selectedWorkspace: Workspace | null;
}

export function useWorkspaceActions({ selectedWorkspace }: UseWorkspaceActionsOptions) {
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
          workspaceLayoutActions.openTerminalTab(selectedWorkspace.id, {
            title: taskName,
            initialCommand: command,
            reveal: true,
          });
        })
        .catch((err) => {
          toast.error(
            `Failed to run task: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        });
    },
    [selectedWorkspace]
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
    // Project environment
    environmentTasks,
    handleRunTask,
  };
}
