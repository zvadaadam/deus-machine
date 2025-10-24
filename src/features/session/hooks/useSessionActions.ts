/**
 * useSessionActions Hook
 *
 * Centralizes all session action handlers (send, stop, compact, create PR).
 * Extracted from SessionPanel to reduce component complexity.
 */

import { useCallback } from 'react';
import { useSendMessage, useStopSession } from '../api/session.queries';

interface UseSessionActionsProps {
  sessionId: string;
  messageInput: string;
  onMessageSent?: () => void;
}

interface UseSessionActionsReturn {
  // Actions
  sendMessage: (customContent?: string) => Promise<void>;
  stopSession: () => Promise<void>;
  compactConversation: () => Promise<void>;
  createPR: () => Promise<void>;

  // Status
  sending: boolean;
}

export function useSessionActions({
  sessionId,
  messageInput,
  onMessageSent,
}: UseSessionActionsProps): UseSessionActionsReturn {
  const sendMessageMutation = useSendMessage();
  const stopSessionMutation = useStopSession();

  const sendMessage = useCallback(async (customContent?: string) => {
    const content = customContent || messageInput.trim();
    if (!content || sendMessageMutation.isPending) return;

    try {
      await sendMessageMutation.mutateAsync({ sessionId, content });
      onMessageSent?.();
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }, [messageInput, sendMessageMutation, sessionId, onMessageSent]);

  const stopSession = useCallback(async () => {
    if (!window.confirm('Stop the current Claude Code session?')) return;
    try {
      await stopSessionMutation.mutateAsync(sessionId);
    } catch (error) {
      console.error('Failed to stop session:', error);
    }
  }, [stopSessionMutation, sessionId]);

  const compactConversation = useCallback(
    () => sendMessage('/compact'),
    [sendMessage]
  );

  const createPR = useCallback(
    () => sendMessage('Create a PR onto main'),
    [sendMessage]
  );

  return {
    sendMessage,
    stopSession,
    compactConversation,
    createPR,
    sending: sendMessageMutation.isPending,
  };
}
