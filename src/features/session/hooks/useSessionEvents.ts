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
import { incrementalFetchAndMerge } from "../lib/messageCache";
import type { Session, SessionStatus, SessionMessageEvent, SessionStatusEvent } from "../types";

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
export function useSessionEvents(sessionId: string | null, workspaceId?: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Only work in Tauri mode (desktop app)
    if (!isTauriEnv || !sessionId) {
      return;
    }

    // Catch-up fetch: reconcile any messages missed while this hook was unmounted
    // (navigation to another session, socket hiccup, app backgrounded, etc.).
    // One cheap DB query on mount — handles ALL stale-cache scenarios.
    incrementalFetchAndMerge(
      queryClient,
      sessionId,
      queryKeys.sessions.messages(sessionId)
    );
    // Also refresh session detail to catch status changes (working→idle during navigation)
    queryClient.invalidateQueries({
      queryKey: queryKeys.sessions.detail(sessionId),
    });

    // Cancelled flag prevents race condition in React Strict Mode:
    // mount → cleanup → mount happens rapidly. Without this flag, the first
    // mount's async listen() promise resolves after cleanup and removes the
    // second mount's listener.
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    function registerListener(promise: Promise<() => void>) {
      promise.then((fn) => {
        if (cancelled) { fn(); return; } // Cleanup already ran — detach immediately
        unlistenFns.push(fn);
      }).catch(() => {
        // listen() can reject if Tauri runtime is torn down during navigation
      });
    }

    // Listen for message events from sidecar-v2
    registerListener(
      listen<SessionMessageEvent>("session:message", (event) => {
        const { id, data } = event.payload;

        // Only process events for this session
        if (id === sessionId) {
          if (import.meta.env.DEV) {
            const dataType = (data as Record<string, unknown>)?.type;
            console.log("[Events] Message received:", { dataType });
          }

          // Incremental fetch: only get messages newer than what we have.
          // Session detail is NOT invalidated here — status changes arrive via
          // the dedicated session:status-changed event listener below.
          incrementalFetchAndMerge(
            queryClient,
            sessionId,
            queryKeys.sessions.messages(sessionId)
          );

          // Invalidate PR status so we detect PRs created/updated by the agent.
          // staleTime (10s) prevents excessive refetches from rapid events.
          if (workspaceId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.workspaces.prStatus(workspaceId),
            });
          }
        }
      })
    );

    // Listen for error events from sidecar-v2
    // Uses setQueryData (direct cache write) instead of invalidateQueries
    // because the error details are already in the event payload — no need
    // for an HTTP round-trip. Same pattern as the status-changed handler.
    registerListener(
      listen<SessionMessageEvent>("session:error", (event) => {
        const { id, error, category } = event.payload;

        if (id === sessionId) {
          console.error("[Events] Session error:", error, category ? `[${category}]` : "");

          queryClient.setQueryData<Session>(
            queryKeys.sessions.detail(sessionId),
            (old) => {
              if (!old) return old;
              return {
                ...old,
                status: "error" as SessionStatus,
                error_message: error ?? null,
                error_category: category ?? null,
              };
            }
          );
        }
      })
    );

    // Listen for status change events from sidecar-v2
    // Replaces 5s polling for working→idle/error transitions.
    // Sidecar emits this from updateSessionStatus() after DB write.
    registerListener(
      listen<SessionStatusEvent>("session:status-changed", (event) => {
        const { id, status, errorMessage, errorCategory } = event.payload;

        if (id === sessionId) {
          if (import.meta.env.DEV) {
            console.log("[Events] Status changed:", status);
          }

          // Direct cache write: we already have the exact new status from the event,
          // so use setQueryData instead of invalidateQueries (avoids a refetch).
          // Workspace list cache is updated by the global listener in
          // useGlobalSessionNotifications (handles ALL sessions, not just active one).
          queryClient.setQueryData<Session>(
            queryKeys.sessions.detail(sessionId),
            (old) => {
              if (!old) return old;
              return {
                ...old,
                status: status as SessionStatus,
                error_message: status === "error" ? (errorMessage ?? null) : null,
                error_category: status === "error" ? (errorCategory ?? null) : null,
              };
            }
          );
        }
      })
    );

    // Cleanup: set cancelled flag so late-resolving promises don't leak listeners
    return () => {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
    };
  }, [sessionId, workspaceId, queryClient]);

}

