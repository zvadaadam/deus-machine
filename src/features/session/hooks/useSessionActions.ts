/**
 * useSessionActions Hook
 *
 * Centralizes all session action handlers (send, stop, compact, create PR).
 * Extracted from SessionPanel to reduce component complexity.
 *
 * Message Flow (sidecar-v2 architecture):
 * 1. User clicks send → HTTP POST saves user message to DB
 * 2. After HTTP success → socketService.sendQuery() triggers agent via sidecar-v2
 * 3. Sidecar-v2 streams response → saves to DB → emits Tauri events
 * 4. useSessionEvents receives events → invalidates React Query cache → UI updates
 */

import { useCallback } from "react";
import { toast } from "sonner";
import { useSendMessage, useStopSession } from "../api/session.queries";
import { socketService } from "@/platform/socket";
import { isTauriEnv } from "@/platform/tauri";
import { track } from "@/platform/analytics";
import { getRuntimeAgentLabel, type RuntimeAgentType } from "../lib/agentRuntime";
import { COMPACT_CONVERSATION, createPRPrompt } from "../lib/sessionPrompts";

interface UseSessionActionsProps {
  sessionId: string;
  workspaceId?: string;
  workspacePath: string;
  messageInput: string;
  model?: string;
  agentType?: RuntimeAgentType;
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
  workspacePath,
  messageInput,
  model,
  agentType = "claude",
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
        // Step 1: Save user message to DB via HTTP
        await sendMessageMutation.mutateAsync({ sessionId, content, model });

        // Step 2: Trigger agent query via sidecar-v2 socket (Tauri only)
        // In web mode, there's no direct sidecar connection
        if (isTauriEnv) {
          try {
            const ack = await socketService.sendQuery(
              sessionId,
              content,
              {
                cwd: workspacePath,
                model,
                // TODO: Pass permissionMode and other settings from session
              },
              agentType
            );
            if (!ack.accepted) {
              console.error("[useSessionActions] Query rejected:", ack.reason);
              toast.error(ack.reason || "Agent rejected the query");
              try {
                await stopSessionMutation.mutateAsync(sessionId);
              } catch {
                // Best-effort cleanup
              }
            }
          } catch (socketError) {
            console.error("[useSessionActions] Socket query failed:", socketError);
            toast.error(
              "Failed to start agent. Your message was saved but the agent may not process it."
            );
            // Reset session status from 'working' back to 'idle' since the agent never started
            try {
              await stopSessionMutation.mutateAsync(sessionId);
            } catch {
              // Best-effort cleanup — session may already be idle
            }
          }
        }

        onMessageSent?.();
      } catch (error) {
        console.error("Failed to send message:", error);
      }
    },
    [
      messageInput,
      model,
      sendMessageMutation,
      stopSessionMutation,
      sessionId,
      workspacePath,
      agentType,
      onMessageSent,
    ]
  );

  const stopSession = useCallback(async () => {
    const agentLabel = getRuntimeAgentLabel(agentType);
    if (!window.confirm(`Stop the current ${agentLabel} session?`)) return;
    try {
      // Cancel the sidecar agent first so it stops consuming API tokens
      if (isTauriEnv) {
        try {
          await socketService.cancelQuery(sessionId, agentType);
        } catch (cancelError) {
          console.error("[useSessionActions] Cancel query failed:", cancelError);
        }
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
