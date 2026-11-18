/**
 * The rules for the message typed before its workspace existed: when it may
 * be sent, and when its chat was spoken to first. Pure, so the hook that acts
 * on them (hooks/useFirstMessageDelivery) only does the sending.
 */
import type { Workspace } from "@shared/types/workspace";
import type { PendingFirstMessage } from "@/features/workspace/store/workspaceStartStore";

type FirstMessageFields = Pick<
  Workspace,
  "id" | "state" | "current_session_id" | "latest_message_sent_at" | "session_status"
>;

export interface FirstMessageDelivery {
  workspaceId: string;
  sessionId: string;
  first: PendingFirstMessage;
}

/** A workspace whose first chat is open and has heard nothing yet. */
function awaitsFirstMessage(
  workspace: FirstMessageFields
): workspace is FirstMessageFields & { current_session_id: string } {
  return (
    workspace.state === "ready" &&
    !!workspace.current_session_id &&
    // Already said once (an earlier delivery, before a reload or a quit): never twice.
    workspace.latest_message_sent_at === null &&
    workspace.session_status !== "working"
  );
}

/** The waiting messages whose workspaces are ready for them now. */
export function dueFirstMessages(
  workspaces: FirstMessageFields[],
  pending: Record<string, PendingFirstMessage>
): FirstMessageDelivery[] {
  return workspaces.flatMap((workspace) => {
    const first = pending[workspace.id];
    return first && awaitsFirstMessage(workspace)
      ? [{ workspaceId: workspace.id, sessionId: workspace.current_session_id, first }]
      : [];
  });
}

/**
 * Waiting messages whose chat was spoken to first, by another device or
 * window (each client keeps its own waiting message). They are never due,
 * and are not to be lost: they go to that chat's composer instead.
 */
export function missedFirstMessages(
  workspaces: FirstMessageFields[],
  pending: Record<string, PendingFirstMessage>
): FirstMessageDelivery[] {
  return workspaces.flatMap((workspace) => {
    const first = pending[workspace.id];
    return first && workspace.current_session_id && workspace.latest_message_sent_at !== null
      ? [{ workspaceId: workspace.id, sessionId: workspace.current_session_id, first }]
      : [];
  });
}
