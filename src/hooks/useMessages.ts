import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { getBaseURL } from "../config/api.config";
import { socketService } from "../services/socket";
import type { Message, FileEdit, FileChangeGroup, SessionStatus, ToolResultBlock } from "../types";

// BASE_URL is now async - use getBaseURL()

interface UseMessagesOptions {
  sessionId: string;
  isSocketConnected: boolean;
}

/**
 * Hook to manage messages, file changes, and session status
 */
export function useMessages({ sessionId, isSocketConnected }: UseMessagesOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [fileChanges, setFileChanges] = useState<FileChangeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle');
  const [isCompacting, setIsCompacting] = useState(false);

  const parseContent = useCallback((content: string) => {
    try {
      const parsed = JSON.parse(content);
      return parsed.message?.content || parsed.content || [];
    } catch (error) {
      // Enhanced error handling for JSON parse failures
      if (import.meta.env.DEV) {
        console.error('[useMessages] ❌ JSON parse error:', {
          error: error instanceof Error ? error.message : String(error),
          contentLength: content.length,
          contentPreview: content.substring(0, 200),
        });

        // Check if it's a control character error
        if (error instanceof SyntaxError && error.message.includes('control character')) {
          const match = error.message.match(/position (\d+)/);
          if (match) {
            const position = parseInt(match[1], 10);
            console.error('[useMessages] Context around error position:', {
              position,
              before: content.substring(Math.max(0, position - 50), position),
              after: content.substring(position, Math.min(content.length, position + 50))
            });
          }
        }
      } else {
        // Production: redacted logs only
        console.error('[useMessages] ❌ JSON parse error (redacted). length=', content.length);
      }

      // If JSON.parse fails, treat it as plain text (legacy format from original OpenDevs)
      return [{ type: 'text', text: content }];
    }
  }, []);

  /**
   * Build a map linking tool_use_id to tool_result blocks
   * This enables tool renderers to display execution status (✓ Applied / ✗ Failed)
   */
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ToolResultBlock>();

    messages.forEach(message => {
      const contentBlocks = parseContent(message.content);
      if (Array.isArray(contentBlocks)) {
        contentBlocks.forEach((block: any) => {
          if (block.type === 'tool_result' && block.tool_use_id) {
            map.set(block.tool_use_id, block);
          }
        });
      }
    });

    if (import.meta.env.DEV) {
      console.log(`[useMessages] Built toolResultMap with ${map.size} results`);
    }

    return map;
  }, [messages, parseContent]);

  const loadMessagesAndStatus = useCallback(async () => {
    try {
      // Load session status
      const sessionRes = await fetch(`${await getBaseURL()}/sessions/${sessionId}`);
      if (!sessionRes.ok) {
        throw new Error(`Status ${sessionRes.status} loading session`);
      }
      const sessionData = await sessionRes.json();
      setSessionStatus(sessionData.status || 'idle');
      setIsCompacting(sessionData.is_compacting === 1);

      // Load messages
      const res = await fetch(`${await getBaseURL()}/sessions/${sessionId}/messages`);
      if (!res.ok) {
        throw new Error(`Status ${res.status} loading messages`);
      }
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
      setLoading(false);
    }
  }, [sessionId, parseContent]);

  const sendMessage = useCallback(async (customContent?: string) => {
    const content = customContent || messageInput.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      // Try Unix Socket first (real-time, <1ms latency)
      if (isSocketConnected) {
        console.log('[useMessages] 📨 Sending via Unix Socket...');
        const response = await socketService.sendMessage(sessionId, content);

        if (response.error) {
          throw new Error(response.error);
        }

        console.log('[useMessages] ✅ Message sent via socket:', response);
      } else {
        // Fallback to HTTP if socket not connected
        console.log('[useMessages] 📨 Sending via HTTP (socket not connected)...');
        await fetch(`${await getBaseURL()}/sessions/${sessionId}/messages`, {
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
      toast.error(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSending(false);
    }
  }, [messageInput, sending, sessionId, isSocketConnected, loadMessagesAndStatus]);

  const stopSession = useCallback(async () => {
    if (!window.confirm('Stop the current Claude Code session?')) {
      return;
    }

    try {
      await fetch(`${await getBaseURL()}/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Trigger reload to update status
      loadMessagesAndStatus();
    } catch (error) {
      console.error('Failed to stop session:', error);
      toast.error(`Failed to stop session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [sessionId, loadMessagesAndStatus]);

  const createPR = useCallback(() => {
    sendMessage('Create a PR onto main');
  }, [sendMessage]);

  const compactConversation = useCallback(() => {
    sendMessage('/compact');
  }, [sendMessage]);

  // Load messages and status on mount and poll based on session status
  useEffect(() => {
    loadMessagesAndStatus();
    // Poll more frequently when session is working (every 1s), less frequently when idle (every 3s)
    const pollInterval = sessionStatus === 'working' ? 1000 : 3000;
    const interval = setInterval(loadMessagesAndStatus, pollInterval);
    return () => clearInterval(interval);
  }, [sessionId, sessionStatus, loadMessagesAndStatus]);

  return {
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
    toolResultMap,
  };
}
