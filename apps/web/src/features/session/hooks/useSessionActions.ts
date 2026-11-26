import { OpError } from "@/platform/ws/runtime-client";
/** Send and steer use the model and settings shown in this chat's composer. */

import { gatewayEffort, type GatewayModel } from "@shared/gateways";
import type { WorkspaceKind } from "@shared/enums";
import { canPlan } from "@shared/harnesses";
import { useCallback } from "react";
import { toast } from "sonner";
import { newTurnId, useSendMessage, useStopSession } from "../api/session.queries";
import { connect, isConnected } from "@/platform/ws";
import { track } from "@/platform/analytics";
import { turnSelection } from "@/shared/agents";
import { COMPACT_CONVERSATION, createPRPrompt } from "../lib/sessionPrompts";
import { composerStore } from "../store/sessionComposerStore";

interface UseSessionActionsProps {
  sessionId: string;
  steerTurnId?: string;
  model?: string;
  gatewayModel?: GatewayModel;
  workspaceId?: string;
  workspaceKind?: WorkspaceKind | null;
  /** Branch PR prompts target (defaults to "main"). */
  targetBranch?: string;
  /** Fires after a successful send. */
  onMessageSent?: () => void;
  onOpenNewTab?: () => void;
}

interface UseSessionActionsReturn {
  /**
   * @param customContent Override the staged content (defaults to composer store's draft).
   * Resolves true only when the send actually reached the backend.
   */
  sendMessage: (customContent?: string, mode?: "steer") => Promise<boolean>;
  stopSession: () => Promise<void>;
  compactConversation: () => Promise<boolean>;
  createPR: () => Promise<boolean>;
  sending: boolean;
}

export function useSessionActions({
  sessionId,
  steerTurnId,
  model,
  gatewayModel,
  workspaceId,
  workspaceKind,
  targetBranch = "main",
  onMessageSent,
  onOpenNewTab,
}: UseSessionActionsProps): UseSessionActionsReturn {
  const sendMessageMutation = useSendMessage();
  const stopSessionMutation = useStopSession();

  const sendMessage = useCallback(
    async (customContent?: string, mode?: "steer") => {
      if (sendMessageMutation.isPending) return false;

      const composer = composerStore().getState().composers[sessionId];
      if (!composer || !model) return false;

      const content = customContent || composer.draft.trim();
      if (!content) return false;

      const selection = turnSelection(model);
      const { agentHarness } = selection;
      try {
        await sendMessageMutation.mutateAsync({
          ...(mode === "steer" ? { mode, turnId: steerTurnId } : { turnId: newTurnId() }),
          sessionId,
          content,
          ...selection,
          permissionMode:
            composer.planModeEnabled && canPlan(agentHarness, workspaceKind) ? "plan" : undefined,
          thinkingLevel: selection.gatewayRevision
            ? gatewayEffort(gatewayModel, composer.thinkingLevel)
            : composer.thinkingLevel,
        });
      } catch (error) {
        if (
          error instanceof OpError &&
          (error.details as { kind?: string } | undefined)?.kind === "connection_changed"
        ) {
          toast.error(error.message, {
            action: onOpenNewTab && { label: "Open in new chat", onClick: () => onOpenNewTab() },
          });
          return false;
        }
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
    [
      sessionId,
      steerTurnId,
      model,
      gatewayModel,
      workspaceKind,
      sendMessageMutation,
      onMessageSent,
      onOpenNewTab,
    ]
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
