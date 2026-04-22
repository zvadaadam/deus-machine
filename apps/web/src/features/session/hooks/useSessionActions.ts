/**
 * useSessionActions — send/stop/compact/createPR for a session.
 *
 * Reads composer state (draft, model, thinking level, plan mode) from
 * `sessionComposerStore` at call time via getState(), so the hook's
 * callbacks don't go stale when the user changes model mid-edit.
 *
 * Message flow (agent-server-owns-send):
 *   1. user clicks send → useSendMessage routes through socket → agent-server
 *   2. agent-server atomically saves user message + sets status=working +
 *      dispatches agent
 *   3. agent-server streams response → saves to DB → notifies backend
 *   4. backend pushes q:snapshot/q:delta to WS subscribers → React Query
 *      cache → UI updates
 */

import { useCallback } from "react";
import { toast } from "sonner";
import { useSendMessage, useStopSession } from "../api/session.queries";
import { sendCommand, connect, isConnected } from "@/platform/ws";
import { track } from "@/platform/analytics";
import { getAgentHarnessForModel, getModelId } from "@/shared/agents";
import { COMPACT_CONVERSATION, createPRPrompt } from "../lib/sessionPrompts";
import { useSessionComposerStore } from "../store/sessionComposerStore";

interface UseSessionActionsProps {
  sessionId: string;
  workspaceId?: string;
  /** Branch PR prompts target (defaults to "main"). */
  targetBranch?: string;
  /** Fires after a successful send. */
  onMessageSent?: () => void;
}

interface UseSessionActionsReturn {
  /**
   * @param customContent Override the staged content (defaults to composer store's draft).
   * @param modelOverride Full model id ("harness:modelId") — for THIS send only.
   *   Used by the home-screen welcome flow where we dispatch the first
   *   message before the user has a chance to interact with a composer.
   */
  sendMessage: (customContent?: string, modelOverride?: string) => Promise<void>;
  stopSession: () => Promise<void>;
  compactConversation: () => Promise<void>;
  createPR: () => Promise<void>;
  sending: boolean;
}

export function useSessionActions({
  sessionId,
  workspaceId,
  targetBranch = "main",
  onMessageSent,
}: UseSessionActionsProps): UseSessionActionsReturn {
  const sendMessageMutation = useSendMessage();
  const stopSessionMutation = useStopSession();

  const sendMessage = useCallback(
    async (customContent?: string, modelOverride?: string) => {
      if (sendMessageMutation.isPending) return;

      const composer = useSessionComposerStore.getState().composers[sessionId];
      if (!composer) return;

      const content = customContent || composer.draft.trim();
      if (!content) return;

      // modelOverride wins for this send only; otherwise use the composer's
      // currently-selected model. Splitting the full "harness:modelId" form
      // into runtime id + harness happens here so callers never think about it.
      const effectiveFull = modelOverride ?? composer.model;
      const effectiveModel = getModelId(effectiveFull);
      const effectiveHarness = getAgentHarnessForModel(effectiveFull);

      try {
        await sendMessageMutation.mutateAsync({
          sessionId,
          content,
          model: effectiveModel,
          agentHarness: effectiveHarness,
          permissionMode: composer.planModeEnabled ? "plan" : undefined,
          thinkingLevel: composer.thinkingLevel,
        });
      } catch (error) {
        console.error("Failed to send message:", error);
        toast.error(error instanceof Error ? error.message : "Failed to send message");
        return;
      }

      try {
        onMessageSent?.();
      } catch (callbackError) {
        console.error("[useSessionActions] onMessageSent callback failed:", callbackError);
      }
    },
    [sessionId, sendMessageMutation, onMessageSent]
  );

  const stopSession = useCallback(async () => {
    try {
      // Cancel the agent first so it stops consuming API tokens.
      try {
        if (!isConnected()) await connect();
        await sendCommand("stopSession", { sessionId });
      } catch (cancelError) {
        console.error("[useSessionActions] Cancel query failed:", cancelError);
      }
      await stopSessionMutation.mutateAsync(sessionId);
    } catch (error) {
      console.error("Failed to stop session:", error);
    }
  }, [stopSessionMutation, sessionId]);

  const compactConversation = useCallback(() => sendMessage(COMPACT_CONVERSATION), [sendMessage]);

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
