/**
 * useSessionActions Hook
 *
 * Centralizes all session action handlers (send, stop, compact, create PR).
 * Extracted from SessionPanel to reduce component complexity.
 *
 * Message Flow (agent-server-owns-send):
 * 1. User clicks send → useSendMessage routes through socket → agent-server
 * 2. Agent-server atomically: saves user message + sets status=working + dispatches agent
 * 3. Agent-server streams response → saves to DB → notifies backend
 * 4. Backend pushes q:snapshot/q:delta to WS subscribers → React Query cache → UI updates
 */

import { useCallback } from "react";
import { toast } from "sonner";
import { useSendMessage, useStopSession } from "../api/session.queries";
import { sendCommand, connect, isConnected } from "@/platform/ws";
import { track } from "@/platform/analytics";
import { type RuntimeAgentType } from "../lib/agentRuntime";
import { COMPACT_CONVERSATION, createPRPrompt } from "../lib/sessionPrompts";

interface UseSessionActionsProps {
  sessionId: string;
  workspaceId?: string;
  messageInput: string;
  model?: string;
  agentType?: RuntimeAgentType;
  permissionMode?: string;
  onMessageSent?: () => void;
  targetBranch?: string;
}

interface UseSessionActionsReturn {
  // Actions
  sendMessage: (customContent?: string) => Promise<void>;
  stopSession: () => Promise<void>;
  compactConversation: () => Promise<void>;
  createPR: () => Promise<void>;

  // Status
  sending: boolean;
}

export function useSessionActions({
  sessionId,
  workspaceId,
  messageInput,
  model,
  agentType = "claude",
  permissionMode,
  onMessageSent,
  targetBranch = "main",
}: UseSessionActionsProps): UseSessionActionsReturn {
  const sendMessageMutation = useSendMessage();
  const stopSessionMutation = useStopSession();

  const sendMessage = useCallback(
    async (customContent?: string) => {
      const content = customContent || messageInput.trim();
      if (!content || sendMessageMutation.isPending) return;

      try {
        // Single atomic call: agent-server saves message + starts agent.
        // Optimistic UI fires in onMutate, rollback fires in onError.
        await sendMessageMutation.mutateAsync({
          sessionId,
          content,
          model,
          agentType,
          permissionMode,
        });
      } catch (error) {
        console.error("Failed to send message:", error);
        // onError already rolled back optimistic update.
        // No stopSession cleanup needed — agent-server didn't persist anything on failure.
        const reason = error instanceof Error ? error.message : "Failed to send message";
        toast.error(reason);
        return;
      }

      try {
        onMessageSent?.();
      } catch (callbackError) {
        console.error("[useSessionActions] onMessageSent callback failed:", callbackError);
      }
    },
    [messageInput, model, sendMessageMutation, sessionId, agentType, permissionMode, onMessageSent]
  );

  const stopSession = useCallback(async () => {
    try {
      // Cancel the agent-server agent first so it stops consuming API tokens
      try {
        if (!isConnected()) await connect();
        await sendCommand("stopSession", { sessionId });
      } catch (cancelError) {
        console.error("[useSessionActions] Cancel query failed:", cancelError);
      }
      // Then update DB status to idle
      await stopSessionMutation.mutateAsync(sessionId);
    } catch (error) {
      console.error("Failed to stop session:", error);
    }
  }, [stopSessionMutation, sessionId, agentType]);

  const compactConversation = useCallback(() => {
    return sendMessage(COMPACT_CONVERSATION);
  }, [sendMessage]);

  const createPR = useCallback(() => {
    if (workspaceId) {
      track("pr_create_requested", { workspace_id: workspaceId, target_branch: targetBranch });
    }
    return sendMessage(createPRPrompt(targetBranch));
  }, [sendMessage, workspaceId, targetBranch]);

  return {
    sendMessage,
    stopSession,
    compactConversation,
    createPR,
    sending: sendMessageMutation.isPending,
  };
}
