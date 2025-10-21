/**
 * Session Query Hooks
 * TanStack Query hooks for Claude Code session management
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SessionService } from '@/services/session.service';
import { queryKeys } from '@/shared/api/queryKeys';
import type { Session, Message, SessionStatus } from '@/shared/types';
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
 * Fetch messages for a session with dynamic polling
 */
export function useMessages(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.messages(sessionId || ''),
    queryFn: () => SessionService.fetchMessages(sessionId!),
    enabled: !!sessionId,
    // Dynamic polling based on session status
    refetchInterval: (query) => {
      // We need to get session status from the session query
      // For now, use conservative polling
      return 2000;
    },
    staleTime: 500,
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

  return {
    session: sessionQuery.data,
    messages: messagesQuery.data || [],
    sessionStatus: (sessionQuery.data?.status as SessionStatus) || 'idle',
    isCompacting: sessionQuery.data?.is_compacting === 1,
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
