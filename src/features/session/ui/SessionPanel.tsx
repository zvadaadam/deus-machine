import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import {
  Chat,
  MessageInput,
} from ".";
import {
  useSocket,
} from "@/shared/hooks";
import {
  useAutoScroll,
  useSessionActions,
} from "../hooks";
import { SessionProvider } from '../context';
import {
  useSessionWithMessages,
} from "../api/session.queries";
import { Button } from "@/components/ui/button";
import { X, ChevronDown } from "lucide-react";

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
    console.log('[SessionPanel] DEBUG:', {
      sessionId,
      messagesCount: messages.length,
      loading,
      sessionStatus,
      firstMessage: messages[0]?.id,
    });
  }

  // Local state for message input
  const [messageInput, setMessageInput] = useState('');

  // Handlers for MessageInput controls
  const handleModelChange = (model: string) => {
    // TODO: Implement API call to update session model
    console.log('[SessionPanel] Model changed to:', model);
  };

  const handleThinkingLevelChange = (level: string) => {
    // TODO: Implement API call to update session thinking level
    console.log('[SessionPanel] Thinking level changed to:', level);
  };

  const handleAttachment = () => {
    // TODO: Implement attachment functionality
    console.log('[SessionPanel] Attachment clicked');
  };

  // Session actions using custom hook
  const {
    sendMessage,
    stopSession,
    compactConversation,
    createPR,
    sending,
  } = useSessionActions({
    sessionId,
    messageInput,
    onMessageSent: () => setMessageInput(''),
  });

  const {
    showScrollButton,
    handleScrollToBottomClick,
  } = useAutoScroll({
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
  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      // Add with double newline for proper formatting
      setMessageInput(prev => {
        const separator = prev.trim() ? '\n\n' : '';
        return prev + separator + text;
      });
    }
  }), [setMessageInput]);

  // Scroll to bottom button (shared between embedded and modal views)
  const scrollToBottomButton = showScrollButton && (
    <div className="absolute bottom-28 right-6 pointer-events-auto z-10">
      <Button
        variant="secondary"
        size="icon"
        className="rounded-full shadow-lg"
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
        <div className="flex flex-col flex-1 min-h-0 w-full relative">
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
          model={session?.model || undefined}
          thinkingLevel={session?.thinking_level || undefined}
          onMessageChange={setMessageInput}
          onSend={() => sendMessage()}
          onStop={stopSession}
          onModelChange={handleModelChange}
          onThinkingLevelChange={handleThinkingLevelChange}
          onAttachment={handleAttachment}
        />
        </div>
      </SessionProvider>
    );
  }

  const handleClose = () => {
    onClose?.();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000]" onClick={handleClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-activity-title"
        className="vibrancy-bg border border-border/20 rounded-xl w-[90%] max-w-[1200px] h-[90vh] flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-border/40 flex justify-between items-center">
          <h2 id="workspace-activity-title" className="m-0 text-2xl text-foreground">Workspace Activity</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            title="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Main Content Area */}
          <div className="flex-1 flex flex-col min-h-0">
            <SessionProvider parseContent={parseContent} toolResultMap={toolResultMap}>
              <div className="flex flex-col flex-1 min-h-0 relative">
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
                model={session?.model || undefined}
                thinkingLevel={session?.thinking_level || undefined}
                onMessageChange={setMessageInput}
                onSend={() => sendMessage()}
                onCompact={compactConversation}
                onCreatePR={createPR}
                onStop={stopSession}
                onModelChange={handleModelChange}
                onThinkingLevelChange={handleThinkingLevelChange}
                onAttachment={handleAttachment}
              />
              </div>
            </SessionProvider>
          </div>
        </div>
      </div>
    </div>
  );
});

SessionPanel.displayName = 'SessionPanel';
