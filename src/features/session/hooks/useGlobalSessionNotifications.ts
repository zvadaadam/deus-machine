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
import { useQueryClient } from "@tanstack/react-query";
import { match } from "ts-pattern";
import {
  isTauriEnv,
  listen,
  createListenerGroup,
  SESSION_ERROR,
  SESSION_ENTER_PLAN_MODE,
  SESSION_STATUS_CHANGED,
} from "@/platform/tauri";
import { sendNotification } from "@/platform/notifications";
import { isWindowFocused } from "@/shared/hooks/useWindowFocus";
import { track } from "@/platform/analytics";
import { applySessionStatusToRepoGroups } from "@/features/workspace/lib/dashboardRealtime";
import type { SessionStatus } from "@shared/types/session";
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

    const listeners = createListenerGroup();

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
    listeners.register(
      listen(SESSION_ERROR, (event) => {
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
    listeners.register(
      listen(SESSION_ENTER_PLAN_MODE, (event) => {
        if (isWindowFocused()) return;

        const { id } = event.payload;
        sendNotification({
          title: "Plan ready for review",
          body: `Session ${id.substring(0, 8)} has a plan waiting for approval`,
          sound: "Ping",
        });
      })
    );

    // --- Global status change → sidebar cache + transition notifications ---
    // useSessionEvents only handles the *current* session. This global listener
    // ensures sidebar status indicators update for ALL sessions instantly.
    //
    // Notification policy hangs off this authoritative domain event rather than
    // React Query cache transitions (a derived view). This avoids timing issues
    // if cache updates are batched, deferred, or arrive out of order.
    listeners.register(
      listen(SESSION_STATUS_CHANGED, (event) => {
        const { id, status } = event.payload;

        // 1. Patch sidebar cache directly (no HTTP round-trip)
        queryClient.setQueriesData<RepoGroup[]>({ queryKey: ["workspaces", "by-repo"] }, (old) =>
          applySessionStatusToRepoGroups(old, event.payload)
        );

        // 2. Detect status transitions for analytics + notifications
        const prevStatus = prevStatusMap.current.get(id);
        prevStatusMap.current.set(id, status as SessionStatus);

        if (!prevStatus || prevStatus === status) return;

        // working → idle = agent finished — track regardless of window focus
        if (prevStatus === "working" && status === "idle") {
          track("ai_turn_completed", {
            session_id: id,
            agent_type: event.payload.agentType,
          });
        }

        if (isWindowFocused()) return;

        // working → idle = agent finished (notification only when backgrounded)
        if (prevStatus === "working" && status === "idle") {
          queueFinished(id);
        }

        // → needs_response = agent needs user input
        if (status === "needs_response") {
          sendNotification({
            title: "Agent needs input",
            body: `Session ${id.substring(0, 8)} is waiting for your response`,
            sound: "Ping",
          });
        }

        // Error and plan-mode notifications are handled by the direct Tauri
        // event listeners above (session:error, session:enter-plan-mode) which
        // fire immediately — no need to duplicate them here.
      })
    );

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
      listeners.cleanup();
      unsubscribeWorkspaces();
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    };
  }, [queryClient]);
}
