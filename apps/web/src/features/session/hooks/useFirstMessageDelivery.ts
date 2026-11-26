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
import { turnSelection } from "@/shared/agents";
import { useDefaultThinkingLevel } from "@/features/settings/api";
import {
  pendingFirstMessages,
  useWorkspaceStartStore,
} from "@/features/workspace/store/workspaceStartStore";
import { newTurnId, useSendMessage } from "../api/session.queries";
import {
  dueFirstMessages,
  firstChatOf,
  missedFirstMessages,
  type FirstMessageDelivery,
} from "../lib/firstMessage";
import { openChat } from "../lib/openChat";
import { returnContentToComposer } from "../lib/returnToComposer";
import {
  composerStore,
  emptyComposer,
  sessionComposerActions,
} from "../store/sessionComposerStore";

export function useFirstMessageDelivery(repoGroups: RepoGroup[], loaded: boolean): void {
  const pending = useWorkspaceStartStore((state) => state.pending);
  const { mutateAsync: send } = useSendMessage();
  const defaultThinking = useDefaultThinkingLevel();
  const store = composerStore();
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
      const chat = firstChatOf(workspace);
      if (chat) {
        sessionComposerActions.move(workspace.id, chat.sessionId, {
          // Spoken to already (from another device, maybe with another agent):
          // its history sets the model, and only what was typed here moves.
          settings: !chat.spokenTo,
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
      void returnContentToComposer(missed.sessionId, missed.first.message, store).catch(() => {});
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
          ...turnSelection(first.model),
          turnId: newTurnId(),
          thinkingLevel,
          permissionMode: first.planMode ? "plan" : undefined,
        });
        pendingFirstMessages.clear(workspaceId);
      } catch (error) {
        pendingFirstMessages.clear(workspaceId);
        await returnContentToComposer(sessionId, first.message, store).catch(() => {});
        const open = () => openChat(workspaceId, sessionId);
        toast.error(getErrorMessage(error), {
          description: "Your message is in that chat's composer.",
          action: { label: "Open", onClick: open },
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
  }, [repoGroups, loaded, pending, send, defaultThinking, store]);
}
