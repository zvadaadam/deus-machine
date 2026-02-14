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
import { ChevronDown } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { chatTheme } from "./theme";
import { useWorkingDuration } from "@/shared/hooks";
import { useAutoScroll } from "../hooks";
import { useSession } from "../context";
import { useMemo, useRef, useEffect } from "react";
import { PixelGrid, type PixelGridVariant } from "./PixelGrid";

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
  onStop?: () => void; // Callback to stop/cancel the session
  className?: string;
}

export function Chat({
  messages,
  loading,
  sessionStatus,
  latestMessageSentAt,
  className,
}: ChatProps) {
  const { parseContent, toolResultMap, parentToolUseMap } = useSession();

  // Chat owns its scroll behavior entirely — refs, hook, and button.
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);

  const { showScrollButton, handleScrollToBottomClick } = useAutoScroll({
    messages,
    messagesContainerRef,
    messagesEndRef,
  });

  // --- Message entrance animation tracking ---
  // seenMessageIds: Prevents re-animation when React Query refetches or
  // the user scrolls. Only messages NOT in this set get entrance animation.
  const seenMessageIds = useRef(new Set<string>());
  // initialLoadDone: The very first batch of messages should appear instantly
  // (no stagger). We mark all initial messages as "seen" on first render.
  const initialLoadDone = useRef(false);

  useEffect(() => {
    if (!initialLoadDone.current && messages.length > 0) {
      // Mark all existing messages as seen so they don't animate
      messages.forEach((m) => seenMessageIds.current.add(m.id));
      initialLoadDone.current = true;
    }
  }, [messages]);

  // Track working duration
  const { formattedDuration } = useWorkingDuration({
    status: sessionStatus,
    latestMessageSentAt,
  });

  // Memoize message filtering to avoid re-parsing JSON on every render
  const renderableMessages = useMemo(() => {
    return messages.filter((message) => {
      // Skip subagent messages — they render nested under Task tool blocks
      if (parentToolUseMap.has(message.id)) return false;

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
  }, [messages, parseContent, parentToolUseMap]);

  /**
   * Derive agent sub-state from the last content block in the message stream.
   * Maps to PixelGrid animation variant:
   * - thinking: last block is ThinkingBlock (extended reasoning)
   * - generating: last block is TextBlock (streaming text)
   * - toolExecuting: last block is ToolUseBlock with no result yet
   * - error: last tool result has is_error=true
   */
  const agentSubState = useMemo((): PixelGridVariant => {
    if (sessionStatus !== "working") return "generating";

    for (let i = renderableMessages.length - 1; i >= 0; i--) {
      const msg = renderableMessages[i];
      if (msg.role !== "assistant") continue;

      const blocks = parseContent(msg.content);
      if (!Array.isArray(blocks) || blocks.length === 0) continue;

      const lastBlock = blocks[blocks.length - 1];
      if (!lastBlock || typeof lastBlock === "string") return "generating";

      switch (lastBlock.type) {
        case "thinking":
          return "thinking";
        case "text":
          return "generating";
        case "tool_use": {
          const result = toolResultMap.get(lastBlock.id);
          if (result?.is_error) return "error";
          if (!result) return "toolExecuting";
          return "generating";
        }
        default:
          return "generating";
      }
    }

    return "generating";
  }, [sessionStatus, renderableMessages, parseContent, toolResultMap]);

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
    <div className={cn("relative min-h-0 flex-1", className)}>
      {/* Scroll container — absolute inset-0 fills the positioning wrapper */}
      <div
        id="chat-messages"
        role="log"
        aria-live="polite"
        className="absolute inset-0 overflow-x-hidden overflow-y-auto scroll-smooth px-6 pt-6 motion-reduce:scroll-auto"
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
              {/* eslint-disable-next-line react-hooks/refs */}
              {turns.map((turn, turnIndex) => {
                const prevTurn = turnIndex > 0 ? turns[turnIndex - 1] : null;
                const nextTurn = turnIndex < turns.length - 1 ? turns[turnIndex + 1] : null;
                const spacingClass = getTurnSpacingClasses(
                  turn,
                  prevTurn,
                  nextTurn,
                  turnIndex === 0
                );

                // Attach lastMessageRef to the LAST RENDERED turn
                const isLastRendered = turnIndex === turns.length - 1;

                if (turn.type === "user") {
                  // Determine if this is a NEW message that should animate in
                  const isNew = !seenMessageIds.current.has(turn.message.id);
                  if (isNew) seenMessageIds.current.add(turn.message.id);

                  return (
                    <div
                      key={turn.message.id}
                      ref={isLastRendered ? lastMessageRef : undefined}
                      className={cn(spacingClass, "min-w-0")}
                      style={
                        isNew
                          ? {
                              animation: "chat-user-enter 150ms ease-out both",
                            }
                          : undefined
                      }
                    >
                      <MessageItem
                        message={turn.message}
                        isLatestAssistant={false}
                        isLastInTurn={true}
                        isWorking={sessionStatus === "working"}
                      />
                    </div>
                  );
                }

                // Assistant turn — animate only when the turn FIRST appears.
                // Use the first message's ID as the turn key. When new messages
                // are appended to an existing turn (tool calls, streaming), the
                // turn key is already seen so no re-animation (no blink).
                const turnKey = turn.messages[0].id;
                const isTurnNew = !seenMessageIds.current.has(turnKey);
                if (isTurnNew) seenMessageIds.current.add(turnKey);
                // Still mark all individual message IDs for future reference
                turn.messages.forEach((m) => seenMessageIds.current.add(m.id));

                return (
                  <div
                    key={turn.messages[0].id}
                    ref={isLastRendered ? lastMessageRef : undefined}
                    className={cn(spacingClass, "min-w-0")}
                    style={
                      isTurnNew
                        ? {
                            animation: "chat-message-enter 150ms ease-out both",
                          }
                        : undefined
                    }
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
                  aria-label={`Working for ${formattedDuration || "0.0s"}`}
                  className={cn(
                    "mr-auto flex items-center gap-2 px-2 py-1.5",
                    indicatorMarginClass
                  )}
                  style={{
                    animation: "chat-block-fade 200ms cubic-bezier(.215,.61,.355,1) both",
                  }}
                >
                  <PixelGrid variant={agentSubState} size={15} className="flex-shrink-0" />
                  <span className="text-foreground ml-1 font-mono text-xs tracking-tight tabular-nums opacity-50">
                    {formattedDuration || "0.0s"}
                  </span>
                </div>
              )}
              {/* Sentinel for auto-scroll IntersectionObserver.
                  MUST be inside the content wrapper (before pb-32 padding) so it's
                  adjacent to the last message. If placed outside, the 128px padding
                  creates a dead zone where the user sees all content but the sentinel
                  is invisible — breaking auto-scroll re-engagement. */}
              <div ref={messagesEndRef} />
            </div>
          </>
        )}
      </div>

      {/* Scroll to bottom button — floats over the chat scroll area */}
      <div
        className={`pointer-events-auto absolute right-6 bottom-4 z-10 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
          showScrollButton
            ? "scale-100 opacity-100"
            : "pointer-events-none scale-90 opacity-0 motion-reduce:scale-100"
        }`}
      >
        <Button
          variant="secondary"
          size="icon"
          className="rounded-full shadow-lg transition-shadow duration-200 hover:shadow-xl motion-reduce:transition-none"
          onClick={handleScrollToBottomClick}
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
          aria-controls="chat-messages"
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
