/**
 * Session Query Hooks
 * TanStack Query hooks for Claude Code session management
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SessionService } from './session.service';
import { queryKeys } from '@/shared/api/queryKeys';
import type { Session, Message, SessionStatus } from '../types';
import { useMemo } from 'react';

/**
 * Fetch session details with dynamic polling based on status
 */
export function useSession(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(sessionId || ''),
    queryFn: () => SessionService.fetchById(sessionId!),
    enabled: !!sessionId,
    // Dynamic polling: faster when working, slower when idle
    refetchInterval: (query) => {
      const session = query.state.data as Session | undefined;
      return session?.status === 'working' ? 1000 : 3000;
    },
    staleTime: 500,
  });
}

/**
 * Fetch messages for a session with smart fallback
 * - Desktop (Tauri): Real-time events, no polling
 * - Web (Browser): Smart polling when session is working
 */
export function useMessages(sessionId: string | null) {
  const session = useSession(sessionId);

  return useQuery({
    queryKey: queryKeys.sessions.messages(sessionId || ''),
    queryFn: () => SessionService.fetchMessages(sessionId!),
    enabled: !!sessionId,
    // ✅ Smart fallback: Events in Tauri, polling in browser
    refetchInterval: (query) => {
      // Desktop mode (Tauri): Events handle updates, no polling
      if (typeof window !== 'undefined' && '__TAURI__' in window) {
        return false;
      }

      // Web mode (Browser): Poll only when session is working
      const sessionData = session.data;
      if (sessionData?.status === 'working') {
        return 2000; // Poll every 2s when Claude is working
      }

      return false; // Don't poll when idle
    },
    staleTime: 30000, // 30 seconds
  });
}

/**
 * Combined hook for session + messages + status
 * Replaces the complex useMessages hook
 */
export function useSessionWithMessages(sessionId: string | null) {
  const sessionQuery = useSession(sessionId);
  const messagesQuery = useMessages(sessionId);

  // Parse content helper (from original useMessages)
  const parseContent = (content: string) => {
    try {
      const parsed = JSON.parse(content);
      return parsed.message?.content || parsed.content || [];
    } catch (error) {
      // If JSON.parse fails, treat it as plain text
      return [{ type: 'text', text: content }];
    }
  };

  // Build tool result map
  const toolResultMap = useMemo(() => {
    const map = new Map();
    if (!messagesQuery.data) return map;

    messagesQuery.data.forEach((message: Message) => {
      const contentBlocks = parseContent(message.content);
      if (Array.isArray(contentBlocks)) {
        contentBlocks.forEach((block: any) => {
          if (block.type === 'tool_result' && block.tool_use_id) {
            map.set(block.tool_use_id, block);
          }
        });
      }
    });

    return map;
  }, [messagesQuery.data]);

  // Get latest user message's sent_at for duration tracking
  const latestMessageSentAt = useMemo(() => {
    if (!messagesQuery.data || messagesQuery.data.length === 0) return null;

    // Find the latest user message
    const latestUserMessage = [...messagesQuery.data]
      .reverse()
      .find((msg: Message) => msg.role === 'user');

    return latestUserMessage?.sent_at || null;
  }, [messagesQuery.data]);

  return {
    session: sessionQuery.data,
    messages: messagesQuery.data || [],
    sessionStatus: (sessionQuery.data?.status as SessionStatus) || 'idle',
    isCompacting: sessionQuery.data?.is_compacting === 1,
    latestMessageSentAt,
    loading: sessionQuery.isLoading || messagesQuery.isLoading,
    error: sessionQuery.error || messagesQuery.error,
    parseContent,
    toolResultMap,
  };
}

/**
 * Send message mutation
 */
export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, content }: { sessionId: string; content: string }) =>
      SessionService.sendMessage(sessionId, content),
    onSuccess: (_, variables) => {
      // Invalidate messages and session to trigger refetch
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.messages(variables.sessionId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.detail(variables.sessionId),
      });
    },
  });
}

/**
 * Stop session mutation
 */
export function useStopSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) => SessionService.stop(sessionId),
    onSuccess: (_, sessionId) => {
      // Invalidate session to update status
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.detail(sessionId),
      });
    },
  });
}
