/**
 * The two ways out of a workspace that failed to start: start it again in
 * place, or delete it. A message that was waiting for the workspace survives
 * both: a retry sends it, and a delete puts it back in Home's composer.
 */
import { useCallback } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import { openNewWorkspace } from "../lib/newWorkspace";
import { useDeleteFailedWorkspace, useRetryWorkspaceInit } from "../api/workspace.queries";
import { useWorkspaceStore } from "../store/workspaceStore";
import { pendingFirstMessages } from "../store/workspaceStartStore";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";

export function useStartRecovery(workspaceId: string, repoId?: string) {
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
    const onScreen = selectedWorkspaceId === workspaceId;
    // What was typed in its start page's composer goes with it.
    sessionComposerActions.discard(workspaceId);
    const pending = pendingFirstMessages.get(workspaceId);
    pendingFirstMessages.clear(workspaceId);
    if (!pending) {
      if (onScreen) selectWorkspace(null);
      toast("Workspace deleted");
      return;
    }
    // The message it was waiting to send goes to Home's composer, to start
    // again from there: not into a toast that expires.
    if (onScreen) {
      openNewWorkspace({ draft: pending.message, repoId });
      toast("Workspace deleted", { description: "Your message is back on Home." });
      return;
    }
    toast("Workspace deleted", {
      description: "Your message was not sent.",
      action: {
        label: "Start again",
        onClick: () => openNewWorkspace({ draft: pending.message, repoId }),
      },
    });
  }, [remove, workspaceId, repoId]);

  return { retryStart, deleteWorkspace, retrying, deleting };
}
