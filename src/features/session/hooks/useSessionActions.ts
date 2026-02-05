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

interface UseSessionActionsProps {
  sessionId: string;
  workspacePath: string;
  messageInput: string;
  onMessageSent?: () => void;
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
  workspacePath,
  messageInput,
  onMessageSent,
}: UseSessionActionsProps): UseSessionActionsReturn {
  const sendMessageMutation = useSendMessage();
  const stopSessionMutation = useStopSession();

  const sendMessage = useCallback(
    async (customContent?: string) => {
      const content = customContent || messageInput.trim();
      if (!content || sendMessageMutation.isPending) return;

      try {
        // Step 1: Save user message to DB via HTTP
        await sendMessageMutation.mutateAsync({ sessionId, content });

        // Step 2: Trigger agent query via sidecar-v2 socket (Tauri only)
        // In web mode, there's no direct sidecar connection
        if (isTauriEnv) {
          try {
            await socketService.sendQuery(sessionId, content, {
              cwd: workspacePath,
              // TODO: Pass model, permissionMode, and other settings from session
            });
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
      sendMessageMutation,
      stopSessionMutation,
      sessionId,
      workspacePath,
      onMessageSent,
    ]
  );

  const stopSession = useCallback(async () => {
    if (!window.confirm("Stop the current Claude Code session?")) return;
    try {
      await stopSessionMutation.mutateAsync(sessionId);
    } catch (error) {
      console.error("Failed to stop session:", error);
    }
  }, [stopSessionMutation, sessionId]);

  const compactConversation = useCallback(() => sendMessage("/compact"), [sendMessage]);

  const createPR = useCallback(() => sendMessage("Create a PR onto main"), [sendMessage]);

  return {
    sendMessage,
    stopSession,
    compactConversation,
    createPR,
    sending: sendMessageMutation.isPending,
  };
}
