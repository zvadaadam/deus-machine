/**
 * A message that was not sent goes back into its chat's composer.
 *
 * Two senders need it. The first message of a new workspace, when the backend
 * refuses the send (`useFirstMessageDelivery`). And any message in a cloud
 * chat that the platform refuses after the backend took the command: the
 * composer was already cleared and the bubble is on screen, so retiring the
 * bubble alone would lose the message (`MESSAGE_SEND_FAILED`, folded in
 * `agentEventFold` and `useCloudDirectSession`). Nothing is resent.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Message } from "../types";
import { processImageFiles } from "./imageAttachments";
import { dropOptimisticMessage } from "./optimisticMessage";
import { readUserMessageContent } from "./userMessageContent";
import { sessionComposerActions, useSessionComposerStore } from "../store/sessionComposerStore";

/** Put a message into the chat's composer: text and images, ahead of anything
 *  typed there since (it was written first), which is kept. */
export async function returnMessageToComposer(
  sessionId: string,
  message: Pick<Message, "parts">
): Promise<void> {
  const { texts, images } = readUserMessageContent(message);
  // Typed there already, whether the chat's composer exists yet or not.
  const { composers, pendingContent } = useSessionComposerStore.getState();
  const typed = (composers[sessionId] ?? pendingContent[sessionId])?.draft ?? "";
  sessionComposerActions.setDraft(
    sessionId,
    [...texts, ...(typed.trim() ? [typed] : [])].join("\n\n")
  );
  if (images.length === 0) return;
  const files = await Promise.all(
    images.map(async (src, index) => {
      const blob = await (await fetch(src)).blob();
      return new File([blob], `image-${index + 1}`, { type: blob.type });
    })
  );
  sessionComposerActions.addImageAttachments(sessionId, await processImageFiles(files));
}

/**
 * A send the platform refused: retire its bubble and put what it said back in
 * the composer. Only the client that sent it holds the bubble, so only that
 * client's composer gets it, and once (a replayed refusal finds no bubble).
 */
export function returnRefusedMessage(
  queryClient: QueryClient,
  sessionId: string,
  turnId: string
): void {
  const refused = dropOptimisticMessage(queryClient, sessionId, turnId);
  if (refused) void returnMessageToComposer(sessionId, refused).catch(() => {});
}
