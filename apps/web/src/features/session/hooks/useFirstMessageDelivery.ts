/**
 * Hands a workspace's start page over to its first chat, once there is one —
 * whichever workspace is on screen. Two things go: the start page's composer
 * (keyed by the workspace; whatever was typed there, and the model it was set
 * to, move to the chat's composer) and the message that was waiting for the
 * workspace, sent once the workspace is ready.
 *
 * The message waits in `workspaceStartStore`, keyed by workspace. Delivery is
 * a plain send to the workspace's first chat, so it needs nothing mounted:
 * three workspaces started in a row from Home each get their message as they
 * become ready, and the app can be showing any of them, or none.
 *
 * A waiting message whose chat was spoken to first, from another device or
 * window, is not sent: it goes into that chat's composer.
 *
 * Sent once. A send the backend refuses is not retried behind the user's
 * back: the message goes into that chat's composer, where it is theirs to
 * send again, and a toast says why.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import type { RepoGroup } from "@shared/types/workspace";
import { getAgentHarnessForModel, getModelId } from "@/shared/agents";
import { useDefaultThinkingLevel } from "@/features/settings/api";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  pendingFirstMessages,
  useWorkspaceStartStore,
} from "@/features/workspace/store/workspaceStartStore";
import { newTurnId, useSendMessage } from "../api/session.queries";
import {
  dueFirstMessages,
  missedFirstMessages,
  type FirstMessageDelivery,
} from "../lib/firstMessage";
import { processImageFiles } from "../lib/imageAttachments";
import { createOptimisticUserMessage } from "../lib/optimisticMessage";
import { readUserMessageContent } from "../lib/userMessageContent";
import {
  emptyComposer,
  sessionComposerActions,
  useSessionComposerStore,
} from "../store/sessionComposerStore";

/** Put a message that could not be sent into the chat's composer: text and
 *  images, ahead of anything typed there since (it was written first). */
async function returnToComposer(sessionId: string, content: string): Promise<void> {
  const { texts, images } = readUserMessageContent(
    createOptimisticUserMessage({ sessionId, turnId: newTurnId(), content })
  );
  // Typed there already, whether the chat's composer exists yet or not.
  const { composers, pendingContent } = useSessionComposerStore.getState();
  const typed = (composers[sessionId] ?? pendingContent[sessionId])?.draft ?? "";
  sessionComposerActions.setDraft(
    sessionId,
    [...texts, ...(typed.trim() ? [typed] : [])].join("\n\n")
  );
  const files = await Promise.all(
    images.map(async (src, index) => {
      const blob = await (await fetch(src)).blob();
      return new File([blob], `image-${index + 1}`, { type: blob.type });
    })
  );
  sessionComposerActions.addImageAttachments(sessionId, await processImageFiles(files));
}

export function useFirstMessageDelivery(repoGroups: RepoGroup[], loaded: boolean): void {
  const pending = useWorkspaceStartStore((state) => state.pending);
  const { mutateAsync: send } = useSendMessage();
  const defaultThinking = useDefaultThinkingLevel();
  const sending = useRef(new Set<string>());

  useEffect(() => {
    if (!loaded) return;
    const workspaces = repoGroups.flatMap((group) => group.workspaces);

    // A message is only ever matched to its own workspace in this list, so one
    // for a workspace this host does not have (another computer's, one deleted
    // elsewhere) waits untouched: the window may switch back to its host.
    // What was typed on the start page moves to the chat before anything is
    // sent, so a delivery below finds the chat's composer already seeded.
    for (const workspace of workspaces) {
      if (workspace.current_session_id) {
        sessionComposerActions.move(workspace.id, workspace.current_session_id, {
          // Spoken to already (from another device, maybe with another agent):
          // its history sets the model, and only what was typed here moves.
          settings: workspace.latest_message_sent_at === null,
        });
      }
    }

    // Another device or window spoke to the chat first: this client's waiting
    // message will never be due. It goes to that chat's composer, unsent and
    // unseeded (the chat's agent was chosen by whoever spoke). Our own send in
    // flight stamps the chat before it is acknowledged, so it is skipped.
    for (const missed of missedFirstMessages(workspaces, pending)) {
      if (sending.current.has(missed.workspaceId)) continue;
      pendingFirstMessages.clear(missed.workspaceId);
      void returnToComposer(missed.sessionId, missed.first.message).catch(() => {});
    }

    const deliver = async ({ workspaceId, sessionId, first }: FirstMessageDelivery) => {
      const thinkingLevel = first.thinkingLevel ?? defaultThinking;
      // The chat's composer shows what the message was sent with.
      sessionComposerActions.seedIfAbsent(sessionId, {
        ...emptyComposer(first.model, thinkingLevel),
        planModeEnabled: !!first.planMode,
      });
      try {
        await send({
          sessionId,
          content: first.message,
          model: getModelId(first.model),
          agentHarness: getAgentHarnessForModel(first.model),
          turnId: newTurnId(),
          thinkingLevel,
          permissionMode: first.planMode ? "plan" : undefined,
        });
        pendingFirstMessages.clear(workspaceId);
      } catch (error) {
        pendingFirstMessages.clear(workspaceId);
        await returnToComposer(sessionId, first.message).catch(() => {});
        const open = () => useWorkspaceStore.getState().selectWorkspace(workspaceId);
        toast.error(getErrorMessage(error), {
          description: "Your message is in that chat's composer.",
          ...(useWorkspaceStore.getState().selectedWorkspaceId === workspaceId
            ? {}
            : { action: { label: "Open", onClick: open } }),
        });
      } finally {
        sending.current.delete(workspaceId);
      }
    };

    for (const due of dueFirstMessages(workspaces, pending)) {
      if (sending.current.has(due.workspaceId)) continue;
      sending.current.add(due.workspaceId);
      void deliver(due);
    }
  }, [repoGroups, loaded, pending, send, defaultThinking]);
}
