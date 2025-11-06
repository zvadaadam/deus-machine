import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { Chat, MessageInput } from ".";
import { useSocket } from "@/shared/hooks";
import { useAutoScroll, useSessionActions, useSessionEvents } from "../hooks";
import { SessionProvider } from "../context";
import { useSessionWithMessages } from "../api/session.queries";
import { Button } from "@/components/ui/button";
import { X, ChevronDown } from "lucide-react";

const CONTENT_WIDTH_CLASSES = "w-full max-w-[960px] mx-auto min-w-0";

interface SessionPanelProps {
  sessionId: string;
  onClose?: () => void;
  embedded?: boolean;
  onCompact?: (handler: () => void) => void;
  onCreatePR?: (handler: () => void) => void;
  onStop?: (handler: () => void) => void;
}

export interface SessionPanelRef {
  insertText: (text: string) => void;
}

export const SessionPanel = forwardRef<SessionPanelRef, SessionPanelProps>(
  ({ sessionId, onClose, embedded = false, onCompact, onCreatePR, onStop }, ref) => {
    const messagesEndRef = useRef<HTMLDivElement>(null); // Empty div at end for scrolling to bottom
    const lastMessageRef = useRef<HTMLDivElement>(null); // Last message element for scrolling to top
    const messagesContainerRef = useRef<HTMLDivElement>(null);

    // Custom hooks (useSocket manages socket connection lifecycle)
    useSocket();

    // ✅ NEW: Listen for real-time session events from Tauri
    useSessionEvents(sessionId);

    // TanStack Query hooks
    const {
      session,
      messages,
      sessionStatus,
      isCompacting,
      latestMessageSentAt,
      loading,
      parseContent,
      toolResultMap,
    } = useSessionWithMessages(sessionId);

    // DEBUG: Log session data
    if (import.meta.env.DEV) {
      console.log("[SessionPanel] DEBUG:", {
        sessionId,
        messagesCount: messages.length,
        loading,
        sessionStatus,
        firstMessage: messages[0]?.id,
      });
    }

    // Local state for message input
    const [messageInput, setMessageInput] = useState("");
    const [thinkingLevel, setThinkingLevel] = useState(session?.thinking_level || "NONE");
    const [model, setModel] = useState(session?.model || "sonnet");

    // Handlers for MessageInput controls
    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      // TODO: Implement API call to update session model
      console.log("[SessionPanel] Model changed to:", newModel);
    };

    const handleThinkingLevelChange = (level: string) => {
      setThinkingLevel(level);
      // TODO: Implement API call to update session thinking level
      console.log("[SessionPanel] Thinking level changed to:", level);
    };

    const handleAttachmentClick = () => {
      // TODO: Implement file picker dialog
      console.log("[SessionPanel] Attachment clicked");
    };

    // TODO: Fetch MCP servers from settings/API
    const mcpServers = [];

    // Show compact button when there are enough messages to benefit from compacting
    const showCompactButton = messages.length > 10;

    // Derive context token count once to avoid duplication
    const contextTokenCount = session?.context_token_count ?? 0;

    // Session actions using custom hook
    const { sendMessage, stopSession, compactConversation, createPR, sending } = useSessionActions({
      sessionId,
      messageInput,
      onMessageSent: () => setMessageInput(""),
    });

    const { showScrollButton, handleScrollToBottomClick } = useAutoScroll({
      messages,
      messagesContainerRef,
      messagesEndRef,
    });

    // Expose action handlers to parent
    useEffect(() => {
      onCompact?.(compactConversation);
      onCreatePR?.(createPR);
      onStop?.(stopSession);
    }, [compactConversation, createPR, stopSession, onCompact, onCreatePR, onStop]);

    // Expose insertText method for browser element selector
    useImperativeHandle(
      ref,
      () => ({
        insertText: (text: string) => {
          // Add with double newline for proper formatting
          setMessageInput((prev) => {
            const separator = prev.trim() ? "\n\n" : "";
            return prev + separator + text;
          });
        },
      }),
      [setMessageInput]
    );

    // Scroll to bottom button (shared between embedded and modal views)
    const scrollToBottomButton = (
      <div
        className={`pointer-events-auto absolute right-6 bottom-20 z-10 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
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
    );

    // If embedded, render without overlay but with message input
    if (embedded) {
      return (
        <SessionProvider parseContent={parseContent} toolResultMap={toolResultMap}>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Removed redundant flex wrapper - CLAUDE.md: Avoid Unnecessary Flex Nesting */}
            <div
              className={`${CONTENT_WIDTH_CLASSES} relative mx-auto flex min-h-0 flex-1 flex-col`}
            >
              <Chat
                messages={messages}
                loading={loading}
                sessionStatus={sessionStatus}
                latestMessageSentAt={latestMessageSentAt}
                messagesEndRef={messagesEndRef}
                lastMessageRef={lastMessageRef}
                messagesContainerRef={messagesContainerRef}
                onStop={stopSession}
              />

              {/* Scroll to bottom button */}
              {scrollToBottomButton}

              {/* Message Input - Sticky at bottom */}
              <MessageInput
                messageInput={messageInput}
                sending={sending}
                sessionStatus={sessionStatus}
                embedded={true}
                model={model}
                thinkingLevel={thinkingLevel}
                mcpServers={mcpServers}
                contextTokenCount={contextTokenCount}
                onMessageChange={setMessageInput}
                onSend={() => sendMessage()}
                onStop={stopSession}
                onModelChange={handleModelChange}
                onThinkingLevelChange={handleThinkingLevelChange}
                onAttachmentClick={handleAttachmentClick}
              />
            </div>
          </div>
        </SessionProvider>
      );
    }

    const handleClose = () => {
      onClose?.();
    };

    return (
      <div
        className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70"
        onClick={handleClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-activity-title"
          className="vibrancy-bg border-border/20 flex h-[90vh] w-[90%] max-w-[1200px] flex-col rounded-xl border shadow-[0_20px_60px_rgba(0,0,0,0.3)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-border/60 flex items-center justify-between border-b p-4">
            <h2 id="workspace-activity-title" className="text-foreground m-0 text-lg font-semibold">
              Workspace Activity
            </h2>
            <Button variant="ghost" size="icon" onClick={handleClose} title="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Main Content Area */}
            <div className="flex min-h-0 flex-1 flex-col">
              <SessionProvider parseContent={parseContent} toolResultMap={toolResultMap}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {/* Removed redundant flex wrapper - CLAUDE.md: Avoid Unnecessary Flex Nesting */}
                  <div
                    className={`${CONTENT_WIDTH_CLASSES} relative mx-auto flex min-h-0 flex-1 flex-col`}
                  >
                    <Chat
                      messages={messages}
                      loading={loading}
                      sessionStatus={sessionStatus}
                      latestMessageSentAt={latestMessageSentAt}
                      messagesEndRef={messagesEndRef}
                      lastMessageRef={lastMessageRef}
                      messagesContainerRef={messagesContainerRef}
                      onStop={stopSession}
                    />

                    {/* Scroll to bottom button */}
                    {scrollToBottomButton}

                    {/* Message Input - Sticky at bottom */}
                    <MessageInput
                      messageInput={messageInput}
                      sending={sending}
                      isCompacting={isCompacting}
                      sessionStatus={sessionStatus}
                      embedded={false}
                      model={model}
                      thinkingLevel={thinkingLevel}
                      showCompactButton={showCompactButton}
                      mcpServers={mcpServers}
                      contextTokenCount={contextTokenCount}
                      onMessageChange={setMessageInput}
                      onSend={() => sendMessage()}
                      onCompact={compactConversation}
                      onCreatePR={createPR}
                      onStop={stopSession}
                      onModelChange={handleModelChange}
                      onThinkingLevelChange={handleThinkingLevelChange}
                      onAttachmentClick={handleAttachmentClick}
                    />
                  </div>
                </div>
              </SessionProvider>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

SessionPanel.displayName = "SessionPanel";
