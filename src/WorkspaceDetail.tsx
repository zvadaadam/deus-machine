import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import type {
  FileChangeGroup,
  FileEdit,
} from "./types";
import {
  Chat,
  MessageInput,
  FileChangesPanel,
} from "./features/workspace/components";
import {
  useMessages,
  useSocket,
  useAutoScroll,
} from "./hooks";
import { Button } from "@/components/ui/button";
import { X, ArrowLeft, ChevronDown } from "lucide-react";

interface WorkspaceDetailProps {
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  embedded?: boolean;
  onCompact?: (handler: () => void) => void;
  onCreatePR?: (handler: () => void) => void;
  onStop?: (handler: () => void) => void;
}

export interface WorkspaceDetailRef {
  insertText: (text: string) => void;
}

export const WorkspaceDetail = forwardRef<WorkspaceDetailRef, WorkspaceDetailProps>(
  ({ sessionId, onClose, embedded = false, onCompact, onCreatePR, onStop }, ref) => {
  const [selectedFile, setSelectedFile] = useState<FileChangeGroup | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Custom hooks
  const { isConnected } = useSocket();

  const {
    messages,
    fileChanges,
    loading,
    messageInput,
    sending,
    sessionStatus,
    isCompacting,
    setMessageInput,
    sendMessage,
    stopSession,
    createPR,
    compactConversation,
    parseContent,
  } = useMessages({ sessionId, isSocketConnected: isConnected });

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
    if (onCompact) onCompact(compactConversation);
    if (onCreatePR) onCreatePR(createPR);
    if (onStop) onStop(stopSession);
  }, [onCompact, onCreatePR, onStop, compactConversation, createPR, stopSession]);

  // Expose insertText method for browser element selector
  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      console.log('[WorkspaceDetail] Inserting text to message input');
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
      <div className="flex flex-col h-full w-full relative">
        <Chat
          messages={messages}
          loading={loading}
          sessionStatus={sessionStatus}
          parseContent={parseContent}
          messagesEndRef={messagesEndRef}
          messagesContainerRef={messagesContainerRef}
        />

        {/* Scroll to Bottom Button */}
        {showScrollButton && (
          <Button
            variant="secondary"
            size="icon"
            className="fixed bottom-24 right-6 rounded-full shadow-lg z-10"
            onClick={handleScrollToBottomClick}
            title="Scroll to bottom"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        )}

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

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000]" onClick={onClose}>
      <div className="vibrancy-bg border border-border/20 rounded-xl w-[90%] max-w-[1200px] h-[90vh] flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.3)]" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 border-b border-border/40 flex justify-between items-center">
          <h2 className="m-0 text-2xl text-foreground">Workspace Activity</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
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
                />

                {/* Scroll to Bottom Button */}
                {showScrollButton && (
                  <Button
                    variant="secondary"
                    size="icon"
                    className="fixed bottom-24 right-6 rounded-full shadow-lg z-10"
                    onClick={handleScrollToBottomClick}
                    title="Scroll to bottom"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                )}

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

WorkspaceDetail.displayName = 'WorkspaceDetail';
