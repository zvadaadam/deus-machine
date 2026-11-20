/**
 * The rules for the message typed before its workspace existed: when it may
 * be sent, and when its chat was spoken to first. Pure, so the hook that acts
 * on them (hooks/useFirstMessageDelivery) only does the sending.
 */
import type { Workspace } from "@shared/types/workspace";
import type { PendingFirstMessage } from "@/features/workspace/store/workspaceStartStore";

type FirstMessageFields = Pick<
  Workspace,
  | "id"
  | "state"
  | "current_session_id"
  | "latest_message_sent_at"
  | "session_status"
  | "first_session_id"
  | "first_session_status"
  | "first_session_message_count"
>;

/**
 * The chat a waiting first message belongs to, and that chat's own state:
 * the workspace's first chat (its id minted with the workspace), whatever
 * chat is current since (another chat, an agent's second opinion, may have
 * been opened). A workspace from before first-chat ids falls back to its
 * current chat.
 */
export function firstChatOf(workspace: FirstMessageFields): {
  sessionId: string;
  status: string | null;
  spokenTo: boolean;
} | null {
  if (workspace.first_session_id && workspace.first_session_status != null)
    return {
      sessionId: workspace.first_session_id,
      status: workspace.first_session_status,
      spokenTo: (workspace.first_session_message_count ?? 0) > 0,
    };
  if (workspace.first_session_id || !workspace.current_session_id) return null;
  return {
    sessionId: workspace.current_session_id,
    status: workspace.session_status,
    spokenTo: workspace.latest_message_sent_at !== null,
  };
}

export interface FirstMessageDelivery {
  workspaceId: string;
  sessionId: string;
  first: PendingFirstMessage;
}

/** The first chat, when it is open and has heard nothing yet. */
function awaitsFirstMessage(workspace: FirstMessageFields): string | null {
  const chat = firstChatOf(workspace);
  return workspace.state === "ready" &&
    chat &&
    // Already said once (an earlier delivery, before a reload or a quit): never twice.
    !chat.spokenTo &&
    chat.status !== "working"
    ? chat.sessionId
    : null;
}

/** The waiting messages whose workspaces are ready for them now. */
export function dueFirstMessages(
  workspaces: FirstMessageFields[],
  pending: Record<string, PendingFirstMessage>
): FirstMessageDelivery[] {
  return workspaces.flatMap((workspace) => {
    const first = pending[workspace.id];
    const sessionId = first ? awaitsFirstMessage(workspace) : null;
    return first && sessionId ? [{ workspaceId: workspace.id, sessionId, first }] : [];
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
    const chat = first ? firstChatOf(workspace) : null;
    return first && chat?.spokenTo
      ? [{ workspaceId: workspace.id, sessionId: chat.sessionId, first }]
      : [];
  });
}
