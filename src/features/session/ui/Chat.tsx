import type { Message, SessionStatus } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";
import { MessageItem } from "./MessageItem";
import { EmptyState } from "@/components/ui/EmptyState";
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

function getMessageSpacingClasses(
  role: MessageRole,
  prevRole: MessageRole | null,
  nextRole: MessageRole | null,
  isFirst: boolean,
): string {
  const isUser = role === "user";

  const topClass = (() => {
    if (isUser) {
      // First user message keeps a generous offset from the top of the log
      if (isFirst) return "mt-8";
      // Avoid double stacking when users send multiple messages back to back
      if (prevRole === "user") return "mt-0";
      return "mt-8";
    }

    // Assistant/system/tool style messages stay tight unless they're the very first entry
    if (isFirst) return "mt-1";
    // Let the previous bubble control the gap (user messages already add mb-8)
    return "mt-0";
  })();

  const bottomClass = (() => {
    if (isUser) {
      return USER_MARGIN_CLASS;
    }

    if (nextRole === "user") {
      return "mb-0";
    }

    if (nextRole) {
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
  onStop?: () => void;  // Callback to stop/cancel the session
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
}: ChatProps) {
  const { parseContent, toolResultMap } = useSession();

  // Track working duration
  const { formattedDuration } = useWorkingDuration({
    status: sessionStatus,
    latestMessageSentAt
  });

  // Memoize message filtering to avoid re-parsing JSON on every render
  const renderableMessages = useMemo(() => {
    return messages.filter((message) => {
      const contentBlocks = parseContent(message.content);
      const isArray = Array.isArray(contentBlocks);
      const onlyToolResults =
        isArray &&
        contentBlocks.length > 0 &&
        contentBlocks.every((block: ContentBlock | string) =>
          typeof block === "object" && block?.type === "tool_result"
        );
      const isEmpty =
        (isArray && contentBlocks.length === 0) ||
        (!isArray && (contentBlocks == null || String(contentBlocks).trim() === ""));
      return !(onlyToolResults || isEmpty);
    });
  }, [messages, parseContent]);

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
      className="relative flex-1 overflow-y-auto overflow-x-hidden scroll-smooth motion-reduce:scroll-auto min-h-0 px-6 pt-6"
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
        <EmptyState
          icon="💬"
          title="No messages yet"
          description="Start a conversation with Claude Code to make changes to your workspace"
          animate
        />
      ) : (
        <>
          <div className="flex flex-col pb-32 min-h-0 min-w-0">
            {renderableMessages.map((message, renderIndex) => {
              const prevRole = renderIndex > 0 ? renderableMessages[renderIndex - 1].role : null;
              const nextRole = renderIndex < renderableMessages.length - 1 ? renderableMessages[renderIndex + 1].role : null;
              const spacingClass = getMessageSpacingClasses(message.role, prevRole, nextRole, renderIndex === 0);

              // Attach lastMessageRef to the LAST RENDERED message (not based on original array index)
              const isLastRendered = renderIndex === renderableMessages.length - 1;

              return (
                <div
                  key={message.id}
                  ref={isLastRendered ? lastMessageRef : undefined}
                  className={cn(spacingClass, "min-w-0")}
                >
                  <MessageItem
                    message={message}
                  />
                </div>
              );
            })}
            {sessionStatus === "working" && (
              <div
                role="status"
                aria-live="polite"
                className={cn(
                  "flex items-center gap-2 p-2.5 px-3.5 mr-auto max-w-[85%] bg-success/10 backdrop-blur-sm border border-success/30 rounded-xl text-success font-medium text-[0.85rem] shadow-sm animate-[pulse_0.6s_ease_infinite] motion-reduce:animate-none",
                  indicatorMarginClass,
                )}
              >
                <div className="w-4 h-4 border-2 border-success/20 border-t-success rounded-full animate-spin motion-reduce:animate-none flex-shrink-0" aria-hidden="true"></div>
                <span>
                  Claude is working...
                  {formattedDuration && (
                    <span className="ml-1.5 text-success/80">({formattedDuration})</span>
                  )}
                </span>
                {onStop && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onStop}
                    className="ml-2 h-6 px-2 text-success/80 hover:text-success hover:bg-success/20"
                    aria-label="Stop session"
                    title="Stop Claude"
                  >
                    <Square className="h-3 w-3" />
                  </Button>
                )}
              </div>
            )}
          </div>
          <div ref={messagesEndRef} />
        </>
      )}
    </div>
  );
}
