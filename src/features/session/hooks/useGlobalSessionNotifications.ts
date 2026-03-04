/**
 * Global Session Notifications
 *
 * Listens to ALL session events (not just the selected one) and sends
 * OS-level notifications when the app is in the background.
 *
 * Notification triggers:
 * - Agent finished working (working → idle)         → Glass sound
 * - Agent error (session:error event)                → Basso sound
 * - Agent needs input (→ needs_response)             → Ping sound
 * - Plan ready for review (session:enter-plan-mode)  → Ping sound
 *
 * When the app is in the foreground, notifications are suppressed —
 * Sonner toasts handle in-app feedback.
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { match } from "ts-pattern";
import { isTauriEnv } from "@/platform/tauri";
import { sendNotification } from "@/platform/notifications";
import { isWindowFocused } from "@/shared/hooks/useWindowFocus";
import { track } from "@/platform/analytics";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Session, SessionStatus, SessionMessageEvent, SessionStatusEvent } from "@shared/types/session";
import type { RepoGroup, SetupStatus } from "@shared/types/workspace";

/**
 * Batches multiple notifications within a short window into a single one.
 * Prevents notification spam when multiple agents finish simultaneously.
 */
const BATCH_WINDOW_MS = 1500;

export function useGlobalSessionNotifications() {
  // Track previous session statuses for transition detection
  const prevStatusMap = useRef(new Map<string, SessionStatus>());
  // Track previous workspace setup statuses for setup failure notifications
  const prevSetupStatusMap = useRef(new Map<string, SetupStatus>());
  // Batch queue for "agent finished" notifications
  const finishedBatch = useRef<string[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauriEnv) return;

    // Cancelled flag prevents race condition in React Strict Mode:
    // mount → cleanup → mount happens rapidly. Without this flag, the first
    // mount's async listen() promise resolves after cleanup and removes the
    // second mount's listener.
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    function registerListener(promise: Promise<() => void>) {
      promise.then((fn) => {
        if (cancelled) { fn(); return; }
        unlistenFns.push(fn);
      }).catch(() => {
        // listen() can reject if Tauri runtime is torn down during navigation
      });
    }

    function flushFinishedBatch() {
      const batch = finishedBatch.current;
      finishedBatch.current = [];
      batchTimerRef.current = undefined;

      if (batch.length === 0 || isWindowFocused()) return;

      if (batch.length === 1) {
        sendNotification({
          title: "Agent finished",
          body: `Session ${batch[0].substring(0, 8)} completed`,
          sound: "Glass",
        });
      } else {
        sendNotification({
          title: `${batch.length} agents finished`,
          body: "Multiple sessions completed",
          sound: "Glass",
        });
      }
    }

    function queueFinished(sessionId: string) {
      finishedBatch.current.push(sessionId);
      if (!batchTimerRef.current) {
        batchTimerRef.current = setTimeout(flushFinishedBatch, BATCH_WINDOW_MS);
      }
    }

    // --- Error notifications (instant, category-aware) ---
    registerListener(
      listen<SessionMessageEvent>("session:error", (event) => {
        const { id, error, category } = event.payload;

        // Analytics fires regardless of window focus — we always want error data
        track("session_error_displayed", {
          session_id: id,
          error_category: category,
        });

        if (isWindowFocused()) return;

        const title = match(category)
          .with("auth", () => "Authentication Error")
          .with("rate_limit", () => "Rate Limited")
          .with("context_limit", () => "Context Limit Reached")
          .with("network", () => "Network Error")
          .with("db_write", () => "Database Error")
          .with("process_exit", () => "Agent Process Crashed")
          .otherwise(() => "Agent Error");
        sendNotification({
          title,
          body: error || `Session ${id.substring(0, 8)} encountered an error`,
          sound: "Basso",
        });
      })
    );

    // --- Plan mode notifications (instant) ---
    registerListener(
      listen<SessionMessageEvent>("session:enter-plan-mode", (event) => {
        if (isWindowFocused()) return;

        const { id } = event.payload;
        sendNotification({
          title: "Plan ready for review",
          body: `Session ${id.substring(0, 8)} has a plan waiting for approval`,
          sound: "Ping",
        });
      })
    );

    // --- Global status change → update workspace list cache directly ---
    // useSessionEvents only handles the *current* session. This global listener
    // ensures sidebar status indicators update for ALL sessions instantly.
    // Uses setQueriesData (direct cache write) instead of invalidateQueries
    // (HTTP round-trip) for immediate sidebar feedback.
    registerListener(
      listen<SessionStatusEvent>(
        "session:status-changed",
        (event) => {
          const { id: sessionId, status, workspaceId } = event.payload;

          queryClient.setQueriesData<RepoGroup[]>(
            { queryKey: ["workspaces", "by-repo"] },
            (old) => {
              if (!old) return old;
              return old.map((group) => ({
                ...group,
                workspaces: group.workspaces.map((ws) =>
                  // Primary: match by workspaceId from event payload (reliable)
                  // Fallback: match by current_session_id (backward compat)
                  (workspaceId && ws.id === workspaceId) || ws.current_session_id === sessionId
                    ? { ...ws, session_status: status as SessionStatus }
                    : ws
                ),
              }));
            }
          );
        }
      )
    );

    // --- Status transition detection via session:message events ---
    // When we receive a message event, the session detail query will be
    // invalidated (by useSessionEvents). We subscribe to cache updates
    // to detect status transitions across ALL sessions.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || !event.query.queryKey[0]) return;

      // Only watch session detail queries: ["sessions", "detail", id]
      const key = event.query.queryKey;
      if (key[0] !== "sessions" || key[1] !== "detail") return;

      const session = event.query.state.data as Session | undefined;
      if (!session?.id || !session.status) return;

      const prevStatus = prevStatusMap.current.get(session.id);
      prevStatusMap.current.set(session.id, session.status);

      // Skip the first observation (no transition to compare)
      if (!prevStatus) return;
      // Skip non-transitions
      if (prevStatus === session.status) return;

      // working → idle = agent finished — track regardless of window focus
      if (prevStatus === "working" && session.status === "idle") {
        track("ai_turn_completed", {
          session_id: session.id,
          agent_type: session.agent_type,
          model: session.model,
          context_used_percent: session.context_used_percent,
        });
      }

      if (isWindowFocused()) return;

      // working → idle = agent finished (notification only when backgrounded)
      if (prevStatus === "working" && session.status === "idle") {
        queueFinished(session.id);
      }

      // → needs_response = agent needs user input
      if (session.status === "needs_response") {
        sendNotification({
          title: "Agent needs input",
          body: `Session ${session.id.substring(0, 8)} is waiting for your response`,
          sound: "Ping",
        });
      }

      // Error and plan-mode notifications are handled by the direct Tauri
      // event listeners above (session:error, session:enter-plan-mode) which
      // fire immediately — no need to duplicate them via cache transitions.
    });

    // --- Setup failure notifications via workspace cache ---
    const unsubscribeWorkspaces = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || !event.query.queryKey[0]) return;

      // Watch workspace list queries: ["workspaces", "by-repo", ...]
      const key = event.query.queryKey;
      if (key[0] !== "workspaces" || key[1] !== "by-repo") return;

      const groups = event.query.state.data as RepoGroup[] | undefined;
      if (!groups) return;

      for (const group of groups) {
        for (const ws of group.workspaces) {
          const prev = prevSetupStatusMap.current.get(ws.id);
          prevSetupStatusMap.current.set(ws.id, ws.setup_status);

          if (!prev) continue; // First observation
          if (prev === ws.setup_status) continue; // No transition

          // running → failed/completed = setup finished — track analytics always
          if (
            prev === "running" &&
            (ws.setup_status === "failed" || ws.setup_status === "completed")
          ) {
            track("workspace_setup_completed", {
              workspace_id: ws.id,
              setup_status: ws.setup_status,
            });
          }

          // running → failed = setup failed
          if (prev === "running" && ws.setup_status === "failed" && !isWindowFocused()) {
            sendNotification({
              title: "Setup failed",
              body: `Workspace ${ws.title || ws.slug} setup failed${ws.error_message ? `: ${ws.error_message}` : ""}`,
              sound: "Basso",
            });
          }

          // running → completed = setup finished (success)
          if (prev === "running" && ws.setup_status === "completed") {
            // Invalidate manifest cache so task buttons appear
            queryClient.invalidateQueries({ queryKey: ["workspaces", "manifest", ws.id] });

            if (!isWindowFocused()) {
              sendNotification({
                title: "Setup complete",
                body: `Workspace ${ws.title || ws.slug} is ready`,
                sound: "Glass",
              });
            }
          }
        }
      }
    });

    return () => {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
      unsubscribe();
      unsubscribeWorkspaces();
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    };
  }, [queryClient]);
}
