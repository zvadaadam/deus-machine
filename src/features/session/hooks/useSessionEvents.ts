/**
 * Session Events Hook
 *
 * Listens for real-time session events from Tauri and updates React Query cache
 * Only works in Tauri mode (desktop app)
 *
 * ARCHITECTURE (Event Flow) - Updated for sidecar-v2:
 * 1. Sidecar-v2 receives Claude SDK response
 * 2. Sidecar-v2 saves message to SQLite (directly)
 * 3. Sidecar-v2 sends JSON-RPC notification to Rust socket
 * 4. Rust parses notification → emits Tauri event
 * 5. This hook receives event → invalidates React Query cache
 * 6. UI updates instantly (<100ms latency)
 *
 * MEMORY LEAK FIX (2025-10-26):
 * - Was: Stored unlisten function in variable, race condition if unmount before promise resolves
 * - Now: Store promise itself, cleanup awaits promise (guaranteed cleanup)
 * - Prevents orphaned listeners on fast navigation between sessions
 */

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { isTauriEnv } from "@/platform/tauri";
import { SessionService, type PaginatedMessages } from "../api/session.service";
import { MESSAGE_PAGE_SIZE, mergeNewerMessages, getLastRealSeq } from "../lib/messageCache";

/**
 * Event payload from sidecar-v2 JSON-RPC notification
 * Sent via: FrontendAPI.sendMessage() → Rust socket.rs → Tauri event
 */
interface SidecarMessageEvent {
  id: string; // Session ID
  type: "message" | "error";
  agentType: "claude" | "codex";
  data?: unknown; // Claude SDK message data (for streaming rendering)
  error?: string;
}

/**
 * Listen for real-time session message events
 *
 * When Claude responds:
 * 1. Sidecar-v2 receives Claude SDK response
 * 2. Sidecar-v2 saves to SQLite & sends JSON-RPC notification
 * 3. Rust emits Tauri event "session:message"
 * 4. This hook receives event
 * 5. Invalidates React Query cache
 * 6. UI updates instantly
 */
export function useSessionEvents(sessionId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Only work in Tauri mode (desktop app)
    if (!isTauriEnv || !sessionId) {
      return;
    }

    // Listen for message events from sidecar-v2
    const unlistenMessagePromise = listen<SidecarMessageEvent>("session:message", (event) => {
      const { id, type, data } = event.payload;

      // Only process events for this session
      if (id === sessionId) {
        if (import.meta.env.DEV) {
          const dataType = (data as Record<string, unknown>)?.type;
          console.log("[Events] 📨 Message received:", { type, dataType });
        }

        // Incremental fetch: only get messages newer than what we have
        const cached = queryClient.getQueryData<PaginatedMessages>(
          queryKeys.sessions.messages(sessionId)
        );

        if (cached) {
          const lastSeq = getLastRealSeq(cached.messages);
          SessionService.fetchMessages(sessionId, {
            after: lastSeq || undefined,
            limit: MESSAGE_PAGE_SIZE,
          })
            .then((newer) => {
              if (newer.messages.length > 0) {
                queryClient.setQueryData<PaginatedMessages>(
                  queryKeys.sessions.messages(sessionId),
                  (old) => mergeNewerMessages(old, newer)
                );
              }
            })
            .catch(() => {
              // Incremental fetch failed — fall back to full invalidation
              queryClient.invalidateQueries({
                queryKey: queryKeys.sessions.messages(sessionId),
              });
            });
        } else {
          // No cache yet — do a full fetch
          queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.messages(sessionId),
          });
        }

        // Always refresh session status (e.g., when result arrives)
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.detail(sessionId),
        });
      }
    });

    // Listen for error events from sidecar-v2
    const unlistenErrorPromise = listen<SidecarMessageEvent>("session:error", (event) => {
      const { id, error } = event.payload;

      if (id === sessionId) {
        console.error("[Events] ❌ Session error:", error);

        // Invalidate session to update status
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.detail(sessionId),
        });
      }
    });

    // Log when listeners are ready (dev only)
    if (import.meta.env.DEV) {
      Promise.all([unlistenMessagePromise, unlistenErrorPromise]).then(() => {
        console.log("[Events] 👂 Listening for session events:", sessionId.substring(0, 8));
      });
    }

    // Cleanup: await promises to get unlisten functions
    return () => {
      unlistenMessagePromise.then((unlisten) => unlisten());
      unlistenErrorPromise.then((unlisten) => unlisten());
      if (import.meta.env.DEV) console.log("[Events] 🔇 Stopped listening for session events");
    };
  }, [sessionId, queryClient]);
}
