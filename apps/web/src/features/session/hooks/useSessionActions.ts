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
import { newTurnId, useSendMessage, useStopSession } from "../api/session.queries";
import { connect, isConnected } from "@/platform/ws";
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
   * Resolves true only when the send actually reached the backend.
   */
  sendMessage: (customContent?: string) => Promise<boolean>;
  stopSession: () => Promise<void>;
  compactConversation: () => Promise<boolean>;
  createPR: () => Promise<boolean>;
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
    async (customContent?: string) => {
      if (sendMessageMutation.isPending) return false;

      const composer = useSessionComposerStore.getState().composers[sessionId];
      if (!composer) return false;

      const content = customContent || composer.draft.trim();
      if (!content) return false;

      try {
        // The composer's model in its full "harness:modelId" form, split here
        // into runtime id + harness so callers never think about it. Kept
        // INSIDE the try/catch because `getModelId` throws for unknown
        // catalog entries — a stale stored model should surface a toast, not
        // an unhandled promise rejection.
        const effectiveModel = getModelId(composer.model);
        const effectiveHarness = getAgentHarnessForModel(composer.model);

        await sendMessageMutation.mutateAsync({
          sessionId,
          content,
          model: effectiveModel,
          agentHarness: effectiveHarness,
          // The send's correlation key: it seeds the optimistic bubble AND
          // becomes the engine's turnId, so the user echo comes back matchable.
          turnId: newTurnId(),
          permissionMode: composer.planModeEnabled ? "plan" : undefined,
          thinkingLevel: composer.thinkingLevel,
        });
      } catch (error) {
        console.error("Failed to send message:", error);
        toast.error(error instanceof Error ? error.message : "Failed to send message");
        // The toast is feedback, not delivery: the caller learns it failed.
        return false;
      }

      try {
        onMessageSent?.();
      } catch (callbackError) {
        console.error("[useSessionActions] onMessageSent callback failed:", callbackError);
      }
      return true;
    },
    [sessionId, sendMessageMutation, onMessageSent]
  );

  const stopSession = useCallback(async () => {
    try {
      // ONE stopSession command. This used to fire the command directly and
      // then run the mutation, which sends the same command again — the second
      // cancel lands on a turn the first already stopped and its
      // `no_active_turn` outcome masks whether the first was ever confirmed.
      if (!isConnected()) await connect();
      await stopSessionMutation.mutateAsync(sessionId);
    } catch (error) {
      console.error("Failed to stop session:", error);
      toast.error(error instanceof Error ? error.message : "Failed to stop session");
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
