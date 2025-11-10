import type { Message, SessionStatus } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";
import { MessageItem } from "./MessageItem";
import { AssistantTurn } from "./AssistantTurn";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { chatTheme } from "./theme";
import { useWorkingDuration } from "@/shared/hooks";
import type { RefObject } from "react";
import { useSession } from "../context";
import { Square } from "lucide-react";
import { useMemo } from "react";

type MessageRole = Message["role"];

// Pull spacing from theme for consistency
const USER_MARGIN_CLASS = chatTheme.spacing.userMessageMargin;
const TIGHT_MARGIN_CLASS = chatTheme.spacing.assistantTightMargin;

/**
 * Turn Types
 *
 * A turn = consecutive messages with the same role (user or assistant)
 * - UserTurn: Single user message
 * - AssistantTurn: One or more consecutive assistant messages
 */
type UserTurn = {
  type: "user";
  message: Message;
  messageIndex: number;
};

type AssistantTurnData = {
  type: "assistant";
  messages: Message[];
  firstMessageIndex: number;
  isLatest: boolean;
};

type Turn = UserTurn | AssistantTurnData;

/**
 * Calculate spacing classes for turns (replaces message-level spacing)
 *
 * A turn = consecutive messages with the same role
 * Spacing logic:
 * - First turn: Minimal top margin
 * - User turn after assistant: Generous top margin (mt-8)
 * - User turn after user: No extra margin (consecutive user messages)
 * - Assistant turn: Tight margin (mt-1)
 * - Bottom margin: User turns add mb-8, assistant turns add minimal margin
 */
function getTurnSpacingClasses(
  turn: Turn,
  prevTurn: Turn | null,
  nextTurn: Turn | null,
  isFirst: boolean
): string {
  const isUser = turn.type === "user";

  const topClass = (() => {
    if (isUser) {
      if (isFirst) return "mt-8";
      if (prevTurn?.type === "user") return "mt-0";
      return "mt-8";
    }

    // Assistant turn
    if (isFirst) return "mt-1";
    return "mt-0";
  })();

  const bottomClass = (() => {
    if (isUser) {
      return USER_MARGIN_CLASS;
    }

    // Assistant turn
    if (nextTurn?.type === "user") {
      return "mb-0";
    }

    if (nextTurn) {
      return TIGHT_MARGIN_CLASS;
    }

    return "mb-0";
  })();

  return cn(topClass, bottomClass);
}

interface ChatProps {
  messages: Message[];
  loading: boolean;
  sessionStatus: SessionStatus;
  latestMessageSentAt?: string | null;
  messagesEndRef: RefObject<HTMLDivElement>;
  lastMessageRef: RefObject<HTMLDivElement>;
  messagesContainerRef: RefObject<HTMLDivElement>;
  onStop?: () => void; // Callback to stop/cancel the session
  className?: string;
}

export function Chat({
  messages,
  loading,
  sessionStatus,
  latestMessageSentAt,
  messagesEndRef,
  lastMessageRef,
  messagesContainerRef,
  onStop,
  className,
}: ChatProps) {
  const { parseContent } = useSession();

  // Track working duration
  const { formattedDuration } = useWorkingDuration({
    status: sessionStatus,
    latestMessageSentAt,
  });

  // Memoize message filtering to avoid re-parsing JSON on every render
  const renderableMessages = useMemo(() => {
    return messages.filter((message) => {
      const contentBlocks = parseContent(message.content);
      const isArray = Array.isArray(contentBlocks);
      const onlyToolResults =
        isArray &&
        contentBlocks.length > 0 &&
        contentBlocks.every(
          (block: ContentBlock | string) =>
            typeof block === "object" && block?.type === "tool_result"
        );
      const isEmpty =
        (isArray && contentBlocks.length === 0) ||
        (!isArray && (contentBlocks == null || String(contentBlocks).trim() === ""));
      return !(onlyToolResults || isEmpty);
    });
  }, [messages, parseContent]);

  /**
   * Group consecutive messages into turns
   *
   * A turn = consecutive messages with the same role
   * - User messages: Each user message is its own turn
   * - Assistant messages: Consecutive assistant messages form a single turn
   *
   * This enables turn-level collapsing (hide intermediate messages, show summary)
   */
  const turns = useMemo(() => {
    const turnList: Turn[] = [];
    let currentAssistantTurn: Message[] | null = null;
    let firstAssistantIndex = -1;

    renderableMessages.forEach((message, index) => {
      if (message.role === "assistant") {
        // Start or continue assistant turn
        if (!currentAssistantTurn) {
          currentAssistantTurn = [message];
          firstAssistantIndex = index;
        } else {
          currentAssistantTurn.push(message);
        }
      } else {
        // User message - close any open assistant turn first
        if (currentAssistantTurn) {
          turnList.push({
            type: "assistant",
            messages: currentAssistantTurn,
            firstMessageIndex: firstAssistantIndex,
            isLatest: false, // Will be updated later
          });
          currentAssistantTurn = null;
        }

        // Add user turn
        turnList.push({
          type: "user",
          message,
          messageIndex: index,
        });
      }
    });

    // Close any remaining assistant turn
    if (currentAssistantTurn) {
      turnList.push({
        type: "assistant",
        messages: currentAssistantTurn,
        firstMessageIndex: firstAssistantIndex,
        isLatest: false, // Will be updated later
      });
    }

    // Mark the latest assistant turn
    for (let i = turnList.length - 1; i >= 0; i--) {
      if (turnList[i].type === "assistant") {
        (turnList[i] as AssistantTurnData).isLatest = true;
        break;
      }
    }

    return turnList;
  }, [renderableMessages]);

  // Calculate indicator margin based on last message role
  const indicatorMarginClass = useMemo(() => {
    const lastRenderableRole = renderableMessages.length
      ? renderableMessages[renderableMessages.length - 1].role
      : null;
    return lastRenderableRole === "user" ? "mt-0" : "mt-1";
  }, [renderableMessages]);

  return (
    <div
      id="chat-messages"
      role="log"
      aria-live="polite"
      className={cn(
        "relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth px-6 pt-6 motion-reduce:scroll-auto",
        className
      )}
      ref={messagesContainerRef}
    >
      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-4 w-[90%]" />
          <Skeleton className="h-4 w-[80%]" />
        </div>
      ) : messages.length === 0 ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia>
              <div className="text-4xl" aria-hidden="true">
                💬
              </div>
            </EmptyMedia>
            <EmptyTitle>No messages yet</EmptyTitle>
            <EmptyDescription>
              Start a conversation with Claude Code to make changes to your workspace
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-col pb-32">
            {turns.map((turn, turnIndex) => {
              const prevTurn = turnIndex > 0 ? turns[turnIndex - 1] : null;
              const nextTurn = turnIndex < turns.length - 1 ? turns[turnIndex + 1] : null;
              const spacingClass = getTurnSpacingClasses(turn, prevTurn, nextTurn, turnIndex === 0);

              // Attach lastMessageRef to the LAST RENDERED turn
              const isLastRendered = turnIndex === turns.length - 1;

              if (turn.type === "user") {
                return (
                  <div
                    key={turn.message.id}
                    ref={isLastRendered ? lastMessageRef : undefined}
                    className={cn(spacingClass, "min-w-0")}
                  >
                    <MessageItem
                      message={turn.message}
                      isLatestAssistant={false}
                      isLastInTurn={true}
                      isWorking={false}
                    />
                  </div>
                );
              }

              // Assistant turn
              return (
                <div
                  key={turn.messages[0].id}
                  ref={isLastRendered ? lastMessageRef : undefined}
                  className={cn(spacingClass, "min-w-0")}
                >
                  <AssistantTurn
                    messages={turn.messages}
                    isLatest={turn.isLatest}
                    isWorking={sessionStatus === "working"}
                  />
                </div>
              );
            })}
            {sessionStatus === "working" && (
              <div
                role="status"
                aria-live="polite"
                aria-label={`Working for ${formattedDuration || "0 seconds"}`}
                className={cn(
                  "mr-auto flex items-center gap-2.5 px-3 py-2",
                  "bg-success/10 border-success/30 rounded-lg border backdrop-blur-sm",
                  "text-success shadow-sm",
                  "animate-gentle-pulse motion-reduce:animate-none",
                  indicatorMarginClass
                )}
              >
                {/* Spinner - shows activity */}
                <div
                  className="border-success/25 border-t-success h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {/* Timer - monospace prevents jumping, prominent size */}
                <span className="font-mono text-sm font-semibold tracking-tight">
                  {formattedDuration || "0s"}
                </span>
              </div>
            )}
          </div>
          <div ref={messagesEndRef} />
        </>
      )}
    </div>
  );
}
