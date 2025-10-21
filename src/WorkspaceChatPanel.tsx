import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback, useMemo } from "react";
import type {
  FileChangeGroup,
  FileEdit,
} from "@/shared/types";
import {
  Chat,
  MessageInput,
  FileChangesPanel,
} from "./features/workspace/components";
import {
  useSocket,
  useAutoScroll,
} from "./hooks";
import {
  useSessionWithMessages,
  useSendMessage,
  useStopSession,
} from "./hooks/queries";
import { Button } from "@/components/ui/button";
import { X, ArrowLeft } from "lucide-react";

interface WorkspaceChatPanelProps {
  sessionId: string;
  onClose?: () => void;
  embedded?: boolean;
  onCompact?: (handler: () => void) => void;
  onCreatePR?: (handler: () => void) => void;
  onStop?: (handler: () => void) => void;
}

export interface WorkspaceChatPanelRef {
  insertText: (text: string) => void;
}

export const WorkspaceChatPanel = forwardRef<WorkspaceChatPanelRef, WorkspaceChatPanelProps>(
  ({ sessionId, onClose, embedded = false, onCompact, onCreatePR, onStop }, ref) => {
  const [selectedFile, setSelectedFile] = useState<FileChangeGroup | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Custom hooks (useSocket manages socket connection lifecycle)
  useSocket();

  // TanStack Query hooks
  const {
    messages,
    sessionStatus,
    isCompacting,
    loading,
    parseContent,
    toolResultMap,
  } = useSessionWithMessages(sessionId);

  const sendMessageMutation = useSendMessage();
  const stopSessionMutation = useStopSession();

  // Local state for message input
  const [messageInput, setMessageInput] = useState('');

  // Extract file changes from messages (memoized to avoid recomputation on every render)
  const fileChanges: FileChangeGroup[] = useMemo(() => {
    const fileMap = new Map<string, FileEdit[]>();

    messages.forEach((message) => {
      const contentBlocks = parseContent(message.content);
      if (Array.isArray(contentBlocks)) {
        contentBlocks.forEach((block: any) => {
          if (block?.type === 'tool_use' && (block.name === 'Edit' || block.name === 'Write' || block.name === 'NotebookEdit')) {
            // Support both file_path and notebook_path (for notebook edits)
            const filePath = block.input?.file_path ?? block.input?.notebook_path;
            if (!filePath) return; // Guard against missing file_path or notebook_path

            if (!fileMap.has(filePath)) {
              fileMap.set(filePath, []);
            }

            // Sanitize timestamp to prevent NaN at render
            const tsNum = Date.parse(message.created_at);
            const timestamp = Number.isFinite(tsNum) ? new Date(tsNum).toISOString() : new Date(0).toISOString();

            fileMap.get(filePath)!.push({
              old_string: block.input.old_string,
              new_string: block.input.new_string,
              content: block.input.content,
              timestamp,
              message_id: message.id,
              tool_name: block.name
            });
          }
        });
      }
    });

    const changes: FileChangeGroup[] = Array.from(fileMap.entries()).map(([file_path, edits]) => {
      // Harden timestamp parsing
      const timestamps = edits
        .map(e => Date.parse(e.timestamp))
        .filter((t) => Number.isFinite(t));

      if (!timestamps.length) {
        return {
          file_path,
          edits,
          first_timestamp: new Date(0).toISOString(),
          last_timestamp: new Date(0).toISOString(),
        };
      }

      return {
        file_path,
        edits,
        first_timestamp: new Date(Math.min(...timestamps)).toISOString(),
        last_timestamp: new Date(Math.max(...timestamps)).toISOString()
      };
    });

    changes.sort((a, b) =>
      new Date(b.last_timestamp).getTime() - new Date(a.last_timestamp).getTime()
    );

    return changes;
  }, [messages, parseContent]);

  // Handlers using mutations
  const sendMessage = useCallback(async (customContent?: string) => {
    const content = customContent || messageInput.trim();
    if (!content || sendMessageMutation.isPending) return;

    try {
      await sendMessageMutation.mutateAsync({ sessionId, content });
      setMessageInput('');
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }, [messageInput, sendMessageMutation, sessionId]);

  const stopSession = useCallback(async () => {
    if (!window.confirm('Stop the current Claude Code session?')) return;
    try {
      await stopSessionMutation.mutateAsync(sessionId);
    } catch (error) {
      console.error('Failed to stop session:', error);
    }
  }, [stopSessionMutation, sessionId]);

  const createPR = useCallback(() => sendMessage('Create a PR onto main'), [sendMessage]);
  const compactConversation = useCallback(() => sendMessage('/compact'), [sendMessage]);

  // Derived state
  const sending = sendMessageMutation.isPending;

  const {
    showScrollButton,
    handleScrollToBottomClick,
  } = useAutoScroll({
    messages,
    sessionStatus,
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


  function renderDiff(fileChange: FileChangeGroup) {
    return (
      <div className="vibrancy-panel border border-border/40 rounded-lg overflow-hidden">
        <div className="p-6 vibrancy-panel border-b border-border/40 flex justify-between items-center">
          <div>
            <h4 className="m-0 mb-2 text-base text-foreground font-mono font-semibold">{fileChange.file_path}</h4>
            <div className="text-sm text-muted-foreground font-sans">
              {fileChange.edits.length} change{fileChange.edits.length > 1 ? 's' : ''} •
              First: {new Date(fileChange.first_timestamp).toLocaleString()} •
              Last: {new Date(fileChange.last_timestamp).toLocaleString()}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 p-4">
          {fileChange.edits.map((edit: FileEdit, idx: number) => {
            if (edit.tool_name === 'Write') {
              return (
                <div key={idx} className="border border-border/40 rounded-md overflow-hidden bg-white/70 dark:bg-black/60 backdrop-blur-[20px] vibrancy-shadow transition-colors duration-200">
                  <div className="flex justify-between items-center p-3 vibrancy-panel border-b border-border/40">
                    <span className="text-xs font-semibold px-3 py-1 rounded-xl bg-success/20 text-success">New File</span>
                    <span className="text-sm text-muted-foreground">{new Date(edit.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre className="p-4 font-mono text-sm leading-relaxed overflow-x-auto m-0 whitespace-pre-wrap break-words bg-success/10 text-success-foreground">{edit.content || ''}</pre>
                </div>
              );
            }

            // Edit tool with old_string and new_string
            return (
              <div key={idx} className="border border-border/40 rounded-md overflow-hidden bg-white/70 dark:bg-black/60 backdrop-blur-[20px] vibrancy-shadow transition-colors duration-200">
                <div className="flex justify-between items-center p-3 vibrancy-panel border-b border-border/40">
                  <span className="text-xs font-semibold px-3 py-1 rounded-xl bg-info/20 text-info">Edit #{idx + 1}</span>
                  <span className="text-sm text-muted-foreground">{new Date(edit.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="grid grid-cols-2 gap-px bg-border/40">
                  <div className="flex flex-col bg-transparent">
                    <div className="p-3 font-semibold text-sm border-b border-border/40 bg-destructive/10 text-destructive">− Removed</div>
                    <pre className="p-4 font-mono text-sm leading-relaxed overflow-x-auto m-0 whitespace-pre-wrap break-words bg-destructive/10 text-destructive-foreground">{edit.old_string || ''}</pre>
                  </div>
                  <div className="flex flex-col bg-transparent">
                    <div className="p-3 font-semibold text-sm border-b border-border/40 bg-success/10 text-success">+ Added</div>
                    <pre className="p-4 font-mono text-sm leading-relaxed overflow-x-auto m-0 whitespace-pre-wrap break-words bg-success/10 text-success-foreground">{edit.new_string || ''}</pre>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // If embedded, render without overlay but with message input
  if (embedded) {
    return (
      <div className="flex flex-col flex-1 min-h-0 w-full relative">
        <Chat
          messages={messages}
          loading={loading}
          sessionStatus={sessionStatus}
          parseContent={parseContent}
          messagesEndRef={messagesEndRef}
          messagesContainerRef={messagesContainerRef}
          showScrollButton={showScrollButton}
          onScrollToBottom={handleScrollToBottomClick}
          toolResultMap={toolResultMap}
        />

        {/* Message Input - Sticky at bottom */}
        <MessageInput
          messageInput={messageInput}
          sending={sending}
          embedded={true}
          onMessageChange={setMessageInput}
          onSend={() => sendMessage()}
        />
      </div>
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
          {/* Files Changed Sidebar */}
          <FileChangesPanel
            fileChanges={fileChanges}
            selectedFile={selectedFile}
            onFileSelect={setSelectedFile}
          />

          {/* Main Content Area */}
          <div className="flex-1 flex flex-col min-h-0">
            {selectedFile ? (
              // Show diff view when file is selected
              <div className="flex-1 overflow-y-auto p-6">
                <div className="py-4 border-b border-border/40 mb-6">
                  <Button
                    variant="ghost"
                    onClick={() => setSelectedFile(null)}
                    className="gap-2"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back to Timeline
                  </Button>
                </div>
                {renderDiff(selectedFile)}
              </div>
            ) : (
              // Show message timeline - Chat + Input
              <>
                <Chat
                  messages={messages}
                  loading={loading}
                  sessionStatus={sessionStatus}
                  parseContent={parseContent}
                  messagesEndRef={messagesEndRef}
                  messagesContainerRef={messagesContainerRef}
                  showScrollButton={showScrollButton}
                  onScrollToBottom={handleScrollToBottomClick}
                  toolResultMap={toolResultMap}
                />

                {/* Message Input - Sticky at bottom */}
                <MessageInput
                  messageInput={messageInput}
                  sending={sending}
                  isCompacting={isCompacting}
                  sessionStatus={sessionStatus}
                  embedded={false}
                  onMessageChange={setMessageInput}
                  onSend={() => sendMessage()}
                  onCompact={compactConversation}
                  onCreatePR={createPR}
                  onStop={stopSession}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

WorkspaceChatPanel.displayName = 'WorkspaceChatPanel';
