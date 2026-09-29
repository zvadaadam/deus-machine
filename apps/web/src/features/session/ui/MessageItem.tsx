/**
 * Message Item
 *
 * Renders a single message in the chat:
 * - Assistant messages: rendered via PartsRenderer (Parts model)
 * - User messages: iMessage-style bubble with text + images
 * - Project conversations: machine inputs inside the user echo render as events
 */

import type { Message } from "@/shared/types";
import { parseProjectPrompt } from "@shared/project-prompt";
import { readUserMessageContent } from "../lib/userMessageContent";
import { useProjectConversation } from "../context/ProjectConversationContext";
import { PartsRenderer } from "./blocks";
import { ProjectInputMessage } from "./ProjectInputMessage";
import { UserBubble } from "./UserBubble";

import { cn } from "@/shared/lib/utils";
import { useMemo, memo } from "react";

interface MessageItemProps {
  message: Message;
  isLastInTurn?: boolean;
  isStreamingTurn?: boolean;
}

/** Assistant message — renders via PartsRenderer. */
const AssistantMessage = memo(function AssistantMessage({
  message,
  isLastInTurn = false,
  isStreamingTurn = false,
}: MessageItemProps) {
  if (!message.parts || message.parts.length === 0) return null;

  return (
    <div
      className={cn(
        "relative",
        "mr-auto w-full max-w-full",
        "flex min-w-0 flex-col gap-1 overflow-x-hidden"
      )}
    >
      <PartsRenderer parts={message.parts} isStreamingTurn={isStreamingTurn && isLastInTurn} />
    </div>
  );
});

/** User message — iMessage-style bubble. */
const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  /**
   * `parts` is the source of truth — the engine's user echo, and the composer's
   * optimistic bubble, which builds the same shapes locally.
   */
  const { images, texts } = useMemo(() => readUserMessageContent(message), [message]);
  // Only a Project agent's conversation receives machine inputs.
  const project = useProjectConversation();
  const segments = useMemo(
    () => (project && images.length === 0 ? texts.flatMap(parseProjectPrompt) : null),
    [project, images.length, texts]
  );

  if (segments?.some((segment) => segment.type === "input"))
    return <ProjectInputMessage messageId={message.id} segments={segments} />;
  return <UserBubble id={message.id} texts={texts} images={images} />;
});

/** Route to AssistantMessage or UserMessage based on role. */
export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  if (props.message.role === "assistant") {
    return <AssistantMessage {...props} />;
  }
  return <UserMessage message={props.message} />;
});
