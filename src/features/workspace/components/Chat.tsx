import type { Message, SessionStatus } from "../../../types";
import { MessageItem } from "./MessageItem";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";

interface ChatProps {
  messages: Message[];
  loading: boolean;
  sessionStatus: SessionStatus;
  parseContent: (content: string) => any;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  messagesContainerRef: React.RefObject<HTMLDivElement>;
  showScrollButton?: boolean;
  onScrollToBottom?: () => void;
}

export function Chat({
  messages,
  loading,
  sessionStatus,
  parseContent,
  messagesEndRef,
  messagesContainerRef,
  showScrollButton = false,
  onScrollToBottom,
}: ChatProps) {
  return (
    <div className="relative flex-1 overflow-y-auto overflow-x-hidden scroll-smooth min-h-0 px-6 pt-6" ref={messagesContainerRef}>
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
          <div className="flex flex-col gap-6 pb-8 min-h-min">
            {messages.map(message => (
              <MessageItem
                key={message.id}
                message={message}
                parseContent={parseContent}
              />
            ))}
          </div>
          {sessionStatus === 'working' && (
            <div className="flex items-center gap-2 p-2.5 px-3.5 mt-2 mr-auto max-w-[85%] bg-success-500/10 backdrop-blur-sm border border-success-500/30 rounded-xl text-success-900 font-medium text-[0.85rem] shadow-sm animate-pulse">
              <div className="w-4 h-4 border-2 border-success-100 border-t-success-500 rounded-full animate-spin flex-shrink-0"></div>
              <span>Claude is working...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </>
      )}
      {showScrollButton && (
        <div className="sticky bottom-6 flex justify-end pointer-events-none pb-6">
          <Button
            variant="secondary"
            size="icon"
            className="rounded-full shadow-lg pointer-events-auto"
            onClick={() => onScrollToBottom?.()}
            title="Scroll to bottom"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
