import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import "./WorkspaceDetail.css";
import type {
  FileChangeGroup,
  FileEdit,
} from "./types";
import {
  MessageList,
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
      <div className="diff-view">
        <div className="diff-header">
          <div>
            <h4>{fileChange.file_path}</h4>
            <div className="diff-meta">
              {fileChange.edits.length} change{fileChange.edits.length > 1 ? 's' : ''} •
              First: {new Date(fileChange.first_timestamp).toLocaleString()} •
              Last: {new Date(fileChange.last_timestamp).toLocaleString()}
            </div>
          </div>
        </div>

        <div className="diff-sections">
          {fileChange.edits.map((edit: FileEdit, idx: number) => {
            if (edit.tool_name === 'Write') {
              return (
                <div key={idx} className="diff-section">
                  <div className="diff-section-header">
                    <span className="diff-badge new-file">New File</span>
                    <span className="diff-time">{new Date(edit.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre className="diff-content new-content">{edit.content || ''}</pre>
                </div>
              );
            }

            // Edit tool with old_string and new_string
            return (
              <div key={idx} className="diff-section">
                <div className="diff-section-header">
                  <span className="diff-badge edit">Edit #{idx + 1}</span>
                  <span className="diff-time">{new Date(edit.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="diff-split">
                  <div className="diff-old">
                    <div className="diff-label">− Removed</div>
                    <pre className="diff-content">{edit.old_string || ''}</pre>
                  </div>
                  <div className="diff-new">
                    <div className="diff-label">+ Added</div>
                    <pre className="diff-content">{edit.new_string || ''}</pre>
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
      <div className="embedded-chat-container">
        <MessageList
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
    <div className="workspace-detail-overlay" onClick={onClose}>
      <div className="workspace-detail" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <h2>Workspace Activity</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            title="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="detail-body">
          {/* Files Changed Sidebar */}
          <FileChangesPanel
            fileChanges={fileChanges}
            selectedFile={selectedFile}
            onFileSelect={setSelectedFile}
          />

          {/* Main Content Area */}
          <div className="detail-content">
            {selectedFile ? (
              // Show diff view when file is selected
              <div className="diff-container">
                <div className="diff-toolbar">
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
              // Show message timeline
              <div className="chat-timeline-container">
                <MessageList
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
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

WorkspaceDetail.displayName = 'WorkspaceDetail';
