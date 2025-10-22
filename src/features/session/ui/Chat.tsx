import type { Message, SessionStatus } from "@/shared/types";
import type { ToolResultMap } from "./chat-types";
import { MessageItem } from "./MessageItem";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReactNode, RefObject } from "react";

interface ChatProps {
  messages: Message[];
  loading: boolean;
  sessionStatus: SessionStatus;
  parseContent: (content: string) => ReactNode;
  messagesEndRef: RefObject<HTMLDivElement>;
  lastMessageRef: RefObject<HTMLDivElement>;
  messagesContainerRef: RefObject<HTMLDivElement>;
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
          <div className="flex flex-col pb-32 min-h-0">
            {(() => {
              // Filter messages first to get renderable messages
              const renderableMessages = messages
                .map((message, originalIndex) => ({ message, originalIndex }))
                .filter(({ message }) => {
                  const contentBlocks = parseContent(message.content);
                  const isArray = Array.isArray(contentBlocks);
                  const onlyToolResults =
                    isArray &&
                    contentBlocks.length > 0 &&
                    contentBlocks.every((block: any) => typeof block === 'object' && block?.type === 'tool_result');
                  const isEmpty =
                    (isArray && contentBlocks.length === 0) ||
                    (!isArray && (contentBlocks == null || String(contentBlocks).trim() === ''));
                  return !(onlyToolResults || isEmpty);
                });

              return renderableMessages.map(({ message, originalIndex }, renderIndex) => {
                // Add spacing logic: user messages get large TOP margin only, assistant messages get minimal margin
                let marginClass = '';
                if (message.role === 'user') {
                  // User messages: large top margin only (no bottom margin to avoid gap before working indicator)
                  marginClass = 'mt-8';
                } else {
                  // Assistant messages: minimal margin
                  marginClass = 'mt-1';
                }

                // Attach lastMessageRef to the LAST RENDERED message (not based on original array index)
                const isLastRendered = renderIndex === renderableMessages.length - 1;

                return (
                  <div
                    key={message.id}
                    ref={isLastRendered ? lastMessageRef : undefined}
                    className={marginClass}
                  >
                    <MessageItem
                      message={message}
                      parseContent={parseContent}
                      toolResultMap={toolResultMap}
                    />
                  </div>
                );
              });
            })()}
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
    </div>
  );
}
