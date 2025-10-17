import { useState, useEffect, useRef } from "react";
import "./WorkspaceDetail.css";
import { socketService } from "./services/socket";
import { API_CONFIG } from "./config/api.config";
import type {
  Message,
  FileEdit,
  FileChangeGroup,
  SessionStatus,
} from "./types";

interface WorkspaceDetailProps {
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  embedded?: boolean;
  onCompact?: (handler: () => void) => void;
  onCreatePR?: (handler: () => void) => void;
  onStop?: (handler: () => void) => void;
}

const API_BASE = API_CONFIG.BASE_URL;

export function WorkspaceDetail({ sessionId, onClose, embedded = false, onCompact, onCreatePR, onStop }: WorkspaceDetailProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [fileChanges, setFileChanges] = useState<FileChangeGroup[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileChangeGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle');
  const [isCompacting, setIsCompacting] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Connect to Unix Socket on mount
  useEffect(() => {
    let socketConnected = false;

    const connectSocket = async () => {
      try {
        await socketService.connect();
        socketConnected = true;
        console.log('[WorkspaceDetail] ✅ Socket connected');
      } catch (error) {
        console.error('[WorkspaceDetail] ❌ Socket connection failed:', error);
        // Fall back to HTTP if socket fails
      }
    };

    connectSocket();

    return () => {
      if (socketConnected) {
        socketService.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    loadMessagesAndStatus();
    // Poll more frequently when session is working (every 1s), less frequently when idle (every 3s)
    const pollInterval = sessionStatus === 'working' ? 1000 : 3000;
    const interval = setInterval(loadMessagesAndStatus, pollInterval);
    return () => clearInterval(interval);
  }, [sessionId, sessionStatus]);

  // Expose action handlers to parent
  useEffect(() => {
    if (onCompact) onCompact(compactConversation);
    if (onCreatePR) onCreatePR(createPR);
    if (onStop) onStop(stopSession);
  }, [onCompact, onCreatePR, onStop]);

  // Only auto-scroll if user is already at bottom or if shouldAutoScroll is true
  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom();
      setShouldAutoScroll(false); // Reset after scrolling
    }
  }, [messages, sessionStatus, shouldAutoScroll]);

  // Handle scroll detection for "scroll to bottom" button
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setShowScrollButton(!isNearBottom);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  function scrollToBottom(smooth = false) {
    messagesEndRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      block: 'end'
    });
  }

  function handleScrollToBottomClick() {
    setShouldAutoScroll(true);
    scrollToBottom(true);
  }

  async function loadMessagesAndStatus() {
    try {
      // Load session status
      const sessionRes = await fetch(`${API_BASE}/sessions/${sessionId}`);
      const sessionData = await sessionRes.json();
      setSessionStatus(sessionData.status || 'idle');
      setIsCompacting(sessionData.is_compacting === 1);

      // Load messages
      const res = await fetch(`${API_BASE}/sessions/${sessionId}/messages`);
      const data = await res.json();
      setMessages(data);

      // Extract and group file changes by file path
      const fileMap = new Map<string, FileEdit[]>();

      data.forEach((message: Message) => {
        const contentBlocks = parseContent(message.content);
        if (Array.isArray(contentBlocks)) {
          contentBlocks.forEach((block: any) => {
            if (block.type === 'tool_use' && (block.name === 'Edit' || block.name === 'Write')) {
              const filePath = block.input.file_path;
              if (!fileMap.has(filePath)) {
                fileMap.set(filePath, []);
              }
              fileMap.get(filePath)!.push({
                old_string: block.input.old_string,
                new_string: block.input.new_string,
                content: block.input.content,
                timestamp: message.created_at,
                message_id: message.id,
                tool_name: block.name
              });
            }
          });
        }
      });

      // Convert map to array of FileChangeGroup objects
      const changes: FileChangeGroup[] = Array.from(fileMap.entries()).map(([file_path, edits]) => {
        const timestamps = edits.map(e => new Date(e.timestamp).getTime());
        return {
          file_path,
          edits,
          first_timestamp: new Date(Math.min(...timestamps)).toISOString(),
          last_timestamp: new Date(Math.max(...timestamps)).toISOString()
        };
      });

      // Sort by most recent change
      changes.sort((a, b) =>
        new Date(b.last_timestamp).getTime() - new Date(a.last_timestamp).getTime()
      );

      setFileChanges(changes);
      setLoading(false);
    } catch (error) {
      console.error("Failed to load messages:", error);
    }
  }

  async function sendMessage(customContent?: string) {
    const content = customContent || messageInput.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      // Try Unix Socket first (real-time, <1ms latency)
      if (socketService.isConnected()) {
        console.log('[WorkspaceDetail] 📨 Sending via Unix Socket...');
        const response = await socketService.sendMessage(sessionId, content);

        if (response.error) {
          throw new Error(response.error);
        }

        console.log('[WorkspaceDetail] ✅ Message sent via socket:', response);
      } else {
        // Fallback to HTTP if socket not connected
        console.log('[WorkspaceDetail] 📨 Sending via HTTP (socket not connected)...');
        await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
      }

      setMessageInput('');
      // Trigger reload of messages and status
      loadMessagesAndStatus();
    } catch (error) {
      console.error('Failed to send message:', error);
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  }

  async function stopSession() {
    if (!window.confirm('Stop the current Claude Code session?')) {
      return;
    }

    try {
      await fetch(`${API_BASE}/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Trigger reload to update status
      loadMessagesAndStatus();
    } catch (error) {
      console.error('Failed to stop session:', error);
      alert('Failed to stop session');
    }
  }

  function createPR() {
    sendMessage('Create a PR onto main');
  }

  function compactConversation() {
    sendMessage('/compact');
  }

  function parseContent(content: string) {
    try {
      const parsed = JSON.parse(content);
      return parsed.message?.content || parsed.content || [];
    } catch (error) {
      // Enhanced error handling for JSON parse failures
      console.error('[WorkspaceDetail] ❌ JSON parse error:', {
        error: error instanceof Error ? error.message : String(error),
        contentLength: content.length,
        contentPreview: content.substring(0, 200),
      });

      // Check if it's a control character error
      if (error instanceof SyntaxError && error.message.includes('control character')) {
        const match = error.message.match(/position (\d+)/);
        if (match) {
          const position = parseInt(match[1]);
          console.error('[WorkspaceDetail] Context around error position:', {
            position,
            before: content.substring(Math.max(0, position - 50), position),
            after: content.substring(position, Math.min(content.length, position + 50))
          });
        }
      }

      // If JSON.parse fails, treat it as plain text (legacy format from original OpenDevs)
      return [{ type: 'text', text: content }];
    }
  }

  function renderToolUse(toolUse: any) {
    return (
      <div key={toolUse.id} className="tool-use">
        <div className="tool-header">
          <span className="tool-icon">🔧</span>
          <strong>{toolUse.name}</strong>
        </div>
        <pre className="tool-input">{JSON.stringify(toolUse.input, null, 2)}</pre>
      </div>
    );
  }

  function renderToolResult(toolResult: any) {
    let content = toolResult.content || "";

    // If content is an array or object, stringify it
    if (typeof content === 'object') {
      content = JSON.stringify(content, null, 2);
    }

    const isError = toolResult.is_error;

    return (
      <div key={toolResult.tool_use_id} className={`tool-result ${isError ? 'error' : ''}`}>
        <div className="tool-result-header">
          <span className="tool-icon">{isError ? '❌' : '✅'}</span>
          <strong>Result</strong>
        </div>
        <pre className="tool-output">{content}</pre>
      </div>
    );
  }

  function renderText(text: any) {
    const textContent = typeof text === 'string' ? text : (text?.text || '');
    return (
      <div key={Math.random()} className="text-block">
        <p>{textContent}</p>
      </div>
    );
  }

  function renderMessage(message: Message) {
    const contentBlocks = parseContent(message.content);

    return (
      <div key={message.id} className={`message message-${message.role}`}>
        <div className="message-header">
          <span className="message-role">{message.role}</span>
          <span className="message-time">
            {new Date(message.created_at).toLocaleTimeString()}
          </span>
        </div>
        <div className="message-content">
          {Array.isArray(contentBlocks) ? (
            contentBlocks.map((block: any) => {
              if (!block) return null;

              if (block.type === 'tool_use') {
                return renderToolUse(block);
              } else if (block.type === 'tool_result') {
                return renderToolResult(block);
              } else if (block.type === 'text' || typeof block === 'string') {
                return renderText(block);
              } else if (typeof block === 'object') {
                // Handle unknown object types - don't try to render them directly
                console.warn('Unknown block type:', block);
                return null;
              }
              return null;
            })
          ) : (
            <pre>{JSON.stringify(contentBlocks, null, 2)}</pre>
          )}
        </div>
      </div>
    );
  }

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
        <div className="messages-scroll-container" ref={messagesContainerRef}>
          <div className="messages-timeline">
            {loading ? (
              <div className="loading" style={{ padding: '24px' }}>
                <div className="skeleton skeleton-avatar" style={{ marginBottom: '16px' }}></div>
                <div className="skeleton skeleton-title" style={{ marginBottom: '12px' }}></div>
                <div className="skeleton skeleton-text" style={{ width: '90%', marginBottom: '12px' }}></div>
                <div className="skeleton skeleton-text" style={{ width: '80%' }}></div>
              </div>
            ) : messages.length === 0 ? (
              <div className="empty-state-enhanced">
                <div className="empty-state-enhanced-icon">💬</div>
                <div className="empty-state-enhanced-title">No messages yet</div>
                <div className="empty-state-enhanced-description">
                  Start a conversation with Claude Code to make changes to your workspace
                </div>
              </div>
            ) : (
              messages.map(renderMessage)
            )}
            {sessionStatus === 'working' && (
              <div className="working-indicator">
                <div className="working-spinner"></div>
                <span>Claude is working...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Scroll to Bottom Button */}
        {showScrollButton && (
          <button
            className="scroll-to-bottom-btn"
            onClick={handleScrollToBottomClick}
            title="Scroll to bottom"
          >
            ↓
          </button>
        )}

        {/* Message Input - Sticky at bottom */}
        <div className="message-input-container sticky-input">
          <div className="input-row">
            <textarea
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              placeholder="Ask Claude Code to make changes, @mention files, run /commands"
              className="message-input"
              disabled={sending}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  sendMessage();
                }
              }}
            />
            <button
              onClick={() => sendMessage()}
              disabled={sending || !messageInput.trim()}
              className="send-button btn-enhanced btn-enhanced-primary"
            >
              <span className="btn-enhanced-icon">{sending ? '⟳' : '➤'}</span>
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-detail-overlay" onClick={onClose}>
      <div className="workspace-detail" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <h2>Workspace Activity</h2>
          <button onClick={onClose} className="close-btn">✕</button>
        </div>

        <div className="detail-body">
          {/* Files Changed Sidebar */}
          <div className="files-sidebar">
            <h3>Files Changed ({fileChanges.length})</h3>
            <div className="files-list">
              {fileChanges.length === 0 ? (
                <p className="no-files">No file changes yet</p>
              ) : (
                fileChanges.map((change, idx) => {
                  const hasWrite = change.edits.some(e => e.tool_name === 'Write');
                  const editCount = change.edits.length;
                  return (
                    <div
                      key={idx}
                      className={`file-item ${selectedFile === change ? 'selected' : ''}`}
                      onClick={() => setSelectedFile(change)}
                    >
                      <div className="file-icon">{hasWrite ? '📄' : '✏️'}</div>
                      <div className="file-info">
                        <div className="file-name">
                          {change.file_path.split('/').pop()}
                          {editCount > 1 && <span className="edit-count">{editCount}</span>}
                        </div>
                        <div className="file-path">{change.file_path}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Main Content Area */}
          <div className="detail-content">
            {selectedFile ? (
              // Show diff view when file is selected
              <div className="diff-container">
                <div className="diff-toolbar">
                  <button onClick={() => setSelectedFile(null)} className="back-btn">← Back to Timeline</button>
                </div>
                {renderDiff(selectedFile)}
              </div>
            ) : (
              // Show message timeline
              <div className="chat-timeline-container">
                <div className="messages-scroll-container" ref={messagesContainerRef}>
                  {loading ? (
                    <div className="loading" style={{ padding: '24px' }}>
                      <div className="skeleton skeleton-avatar" style={{ marginBottom: '16px' }}></div>
                      <div className="skeleton skeleton-title" style={{ marginBottom: '12px' }}></div>
                      <div className="skeleton skeleton-text" style={{ width: '90%', marginBottom: '12px' }}></div>
                      <div className="skeleton skeleton-text" style={{ width: '80%' }}></div>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="empty-state-enhanced">
                      <div className="empty-state-enhanced-icon">💬</div>
                      <div className="empty-state-enhanced-title">No messages yet</div>
                      <div className="empty-state-enhanced-description">
                        Start a conversation with Claude Code to make changes to your workspace
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="messages-timeline">
                        {messages.map(renderMessage)}
                      </div>
                      {sessionStatus === 'working' && (
                        <div className="working-indicator">
                          <div className="working-spinner"></div>
                          <span>Claude is working...</span>
                        </div>
                      )}
                      <div ref={messagesEndRef} />
                    </>
                  )}
                </div>

                {/* Scroll to Bottom Button */}
                {showScrollButton && (
                  <button
                    className="scroll-to-bottom-btn"
                    onClick={handleScrollToBottomClick}
                    title="Scroll to bottom"
                  >
                    ↓
                  </button>
                )}

                {/* Message Input - Sticky at bottom */}
                <div className="message-input-container sticky-input">
                  <div className="input-actions-top">
                    <button
                      onClick={compactConversation}
                      disabled={sending || isCompacting}
                      className="compact-button btn-enhanced btn-enhanced-primary"
                      title="Compact conversation to reduce context size"
                      style={{ fontSize: '13px', padding: '6px 12px' }}
                    >
                      <span className="btn-enhanced-icon">{isCompacting ? '🔄' : '📦'}</span>
                      {isCompacting ? 'Compacting...' : 'Compact'}
                    </button>
                    <button
                      onClick={createPR}
                      disabled={sending}
                      className="create-pr-button btn-enhanced btn-enhanced-success"
                      title="Send 'Create a PR onto main' message"
                      style={{ fontSize: '13px', padding: '6px 12px' }}
                    >
                      <span className="btn-enhanced-icon">🔀</span>
                      Create PR
                    </button>
                    {sessionStatus === 'working' && (
                      <button
                        onClick={stopSession}
                        className="stop-button btn-enhanced btn-enhanced-error"
                        title="Stop Claude Code execution"
                        style={{ fontSize: '13px', padding: '6px 12px' }}
                      >
                        <span className="btn-enhanced-icon">⏹</span>
                        Stop
                      </button>
                    )}
                  </div>
                  <div className="input-row">
                    <textarea
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      placeholder="Ask Claude Code to make changes, @mention files, run /commands"
                      className="message-input"
                      disabled={sending}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          sendMessage();
                        }
                      }}
                    />
                    <button
                      onClick={() => sendMessage()}
                      disabled={sending || !messageInput.trim()}
                      className="send-button btn-enhanced btn-enhanced-primary"
                    >
                      <span className="btn-enhanced-icon">{sending ? '⟳' : '➤'}</span>
                      {sending ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
