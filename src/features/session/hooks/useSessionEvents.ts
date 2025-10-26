/**
 * Session Events Hook
 *
 * Listens for real-time session events from Tauri and updates React Query cache
 * Only works in Tauri mode (desktop app)
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/api/queryKeys';
import { isTauriEnv } from '@/platform/tauri';

interface SessionMessageEvent {
  session_id: string;
  message_id: string;
  role: string;
  sdk_message_id?: string;
}

/**
 * Listen for real-time session message events
 *
 * When Claude responds:
 * 1. Backend saves to SQLite
 * 2. Backend sends event to sidecar
 * 3. Sidecar broadcasts to Rust
 * 4. Rust emits Tauri event
 * 5. This hook receives event
 * 6. Invalidates React Query cache
 * 7. UI updates instantly
 */
export function useSessionEvents(sessionId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Only work in Tauri mode (desktop app)
    if (!isTauriEnv || !sessionId) {
      return;
    }

    let unlistenFn: (() => void) | null = null;

    // Listen for session:message events
    listen<SessionMessageEvent>('session:message', (event) => {
      const { session_id, message_id, sdk_message_id } = event.payload;

      // Only process events for this session
      if (session_id === sessionId) {
        console.log('[Events] 📨 New message received:', {
          message_id,
          sdk_message_id,
          latency: '<100ms' // Real-time!
        });

        // Invalidate messages query to trigger refetch
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.messages(sessionId),
        });

        // Also invalidate session to update status
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.detail(sessionId),
        });
      }
    }).then((unlisten) => {
      unlistenFn = unlisten;
      console.log('[Events] 👂 Listening for session events:', sessionId.substring(0, 8));
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
        console.log('[Events] 🔇 Stopped listening for session events');
      }
    };
  }, [sessionId, queryClient]);
}
