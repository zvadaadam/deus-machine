import type { Message, SessionStatus } from "@/shared/types";
import type { ToolResultMap } from "./chat-types";
import { MessageItem } from "./MessageItem";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import type { ReactNode, RefObject } from "react";

interface ChatProps {
  messages: Message[];
  loading: boolean;
  sessionStatus: SessionStatus;
  parseContent: (content: string) => ReactNode;
  messagesEndRef: RefObject<HTMLDivElement>;
  lastMessageRef: RefObject<HTMLDivElement>;
  messagesContainerRef: RefObject<HTMLDivElement>;
  showScrollButton?: boolean;
  onScrollToBottom?: () => void;
  toolResultMap: ToolResultMap;
}

export function Chat({
  messages,
  loading,
  sessionStatus,
  parseContent,
  messagesEndRef,
  lastMessageRef,
  messagesContainerRef,
  showScrollButton = false,
  onScrollToBottom,
  toolResultMap,
}: ChatProps) {
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
          <div className="flex flex-col gap-6 pb-8 min-h-0">
            {messages.map((message, index) => (
              <div
                key={message.id}
                ref={index === messages.length - 1 ? lastMessageRef : undefined}
              >
                <MessageItem
                  message={message}
                  parseContent={parseContent}
                  toolResultMap={toolResultMap}
                />
              </div>
            ))}
          </div>
          {sessionStatus === 'working' && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 p-2.5 px-3.5 mt-2 mr-auto max-w-[85%] bg-success/10 backdrop-blur-sm border border-success/30 rounded-xl text-success font-medium text-[0.85rem] shadow-sm animate-[pulse_0.6s_ease_infinite] motion-reduce:animate-none"
            >
              <div className="w-4 h-4 border-2 border-success/20 border-t-success rounded-full animate-spin motion-reduce:animate-none flex-shrink-0" aria-hidden="true"></div>
              <span>Claude is working...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </>
      )}
      {showScrollButton && (
        <div className="absolute bottom-6 right-6 pointer-events-auto">
          <Button
            variant="secondary"
            size="icon"
            className="rounded-full shadow-lg"
            onClick={() => onScrollToBottom?.()}
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
            aria-controls="chat-messages"
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
