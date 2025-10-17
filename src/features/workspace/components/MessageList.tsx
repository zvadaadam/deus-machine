import type { Message, SessionStatus } from "../../../types";
import { MessageItem } from "./MessageItem";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  sessionStatus: SessionStatus;
  parseContent: (content: string) => any;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  messagesContainerRef: React.RefObject<HTMLDivElement>;
}

export function MessageList({
  messages,
  loading,
  sessionStatus,
  parseContent,
  messagesEndRef,
  messagesContainerRef,
}: MessageListProps) {
  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth min-h-0" ref={messagesContainerRef}>
      {loading ? (
        <div className="p-6 space-y-4">
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
          <div className="flex flex-col gap-3 p-2 pb-8 min-h-min">
            {messages.map(message => (
              <MessageItem
                key={message.id}
                message={message}
                parseContent={parseContent}
              />
            ))}
          </div>
          {sessionStatus === 'working' && (
            <div className="flex items-center gap-2 p-2.5 px-3.5 mt-2 mr-auto max-w-[85%] bg-success-50 border border-success-200 rounded-xl text-success-900 font-medium text-[0.85rem] shadow-sm animate-pulse">
              <div className="w-4 h-4 border-2 border-success-100 border-t-success-500 rounded-full animate-spin flex-shrink-0"></div>
              <span>Claude is working...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </>
      )}
    </div>
  );
}
