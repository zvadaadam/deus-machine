/**
 * The two ways out of a workspace that failed to start: start it again in
 * place, or delete it. A message that was waiting for the workspace survives
 * both: a retry sends it, and a delete offers it back.
 */
import { useCallback } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import { openNewWorkspace } from "../lib/newWorkspace";
import { useDeleteFailedWorkspace, useRetryWorkspaceInit } from "../api/workspace.queries";
import { useWorkspaceStore } from "../store/workspaceStore";
import { pendingFirstMessages } from "../store/workspaceStartStore";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";

export function useStartRecovery(workspaceId: string) {
  const { mutateAsync: retry, isPending: retrying } = useRetryWorkspaceInit();
  const { mutateAsync: remove, isPending: deleting } = useDeleteFailedWorkspace();

  const retryStart = useCallback(() => {
    retry(workspaceId).catch((error) => toast.error(getErrorMessage(error)));
  }, [retry, workspaceId]);

  // Awaited, not `mutate(..., { onSuccess })`: deleting removes the workspace
  // from the list, which unmounts whoever asked, and callbacks given to
  // `mutate` are dropped with the component.
  const deleteWorkspace = useCallback(async () => {
    try {
      await remove(workspaceId);
    } catch (error) {
      toast.error(getErrorMessage(error));
      return;
    }
    const { selectedWorkspaceId, selectWorkspace } = useWorkspaceStore.getState();
    if (selectedWorkspaceId === workspaceId) selectWorkspace(null);
    // What was typed in its start page's composer goes with it.
    sessionComposerActions.discard(workspaceId);
    const pending = pendingFirstMessages.get(workspaceId);
    pendingFirstMessages.clear(workspaceId);
    if (!pending) {
      toast("Workspace deleted");
      return;
    }
    toast("Workspace deleted", {
      description: "Your message was kept.",
      duration: 10_000,
      action: {
        label: "Start again",
        onClick: () => openNewWorkspace({ draft: pending.message }),
      },
    });
  }, [remove, workspaceId]);

  return { retryStart, deleteWorkspace, retrying, deleting };
}
