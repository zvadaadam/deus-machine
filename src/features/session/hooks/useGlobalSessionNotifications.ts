/**
 * Global Session Notifications
 *
 * Sends OS-level notifications when the app is in the background.
 *
 * Notification triggers:
 * - Agent finished working (working → idle)                → Glass sound
 * - Agent error (→ error with error_category)              → Basso sound
 * - Agent needs input (→ needs_response)                   → Ping sound
 * - Plan ready for review (→ needs_plan_response)          → Ping sound
 * - Setup failed/completed                                 → Basso/Glass sound
 *
 * All transitions are detected by observing the workspace React Query cache,
 * which is kept fresh by the WS subscription. No Tauri event listeners needed.
 *
 * When the app is in the foreground, notifications are suppressed —
 * Sonner toasts handle in-app feedback.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { match } from "ts-pattern";
import { isTauriEnv } from "@/platform/tauri";
import { sendNotification } from "@/platform/notifications";
import { isWindowFocused } from "@/shared/hooks/useWindowFocus";
import { track } from "@/platform/analytics";
import type { SessionStatus } from "@shared/types/session";
import type { RepoGroup, SetupStatus } from "@shared/types/workspace";

/**
 * Batches multiple notifications within a short window into a single one.
 * Prevents notification spam when multiple agents finish simultaneously.
 */
const BATCH_WINDOW_MS = 1500;

export function useGlobalSessionNotifications() {
  const prevStatusMap = useRef(new Map<string, SessionStatus>());
  const prevSetupStatusMap = useRef(new Map<string, SetupStatus>());
  const finishedBatch = useRef<string[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauriEnv) return;

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

    // Detect all session + setup transitions from the workspace cache.
    // The WS subscription pushes updated workspace rows including
    // session_status, session_error_category, and session_error_message.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || !event.query.queryKey[0]) return;

      const key = event.query.queryKey;
      if (key[0] !== "workspaces" || key[1] !== "by-repo") return;

      const groups = event.query.state.data as RepoGroup[] | undefined;
      if (!groups) return;

      for (const group of groups) {
        for (const ws of group.workspaces) {
          // --- Session status transitions ---
          if (ws.current_session_id && ws.session_status) {
            const sessionId = ws.current_session_id;
            const status = ws.session_status as SessionStatus;
            const prevStatus = prevStatusMap.current.get(sessionId);
            prevStatusMap.current.set(sessionId, status);

            if (prevStatus && prevStatus !== status) {
              // working → idle = agent finished
              if (prevStatus === "working" && status === "idle") {
                track("ai_turn_completed", { session_id: sessionId });
                if (!isWindowFocused()) queueFinished(sessionId);
              }

              // → needs_response = agent needs user input
              if (status === "needs_response" && !isWindowFocused()) {
                sendNotification({
                  title: "Agent needs input",
                  body: `Session ${sessionId.substring(0, 8)} is waiting for your response`,
                  sound: "Ping",
                });
              }

              // → needs_plan_response = plan ready for review
              if (status === "needs_plan_response" && !isWindowFocused()) {
                sendNotification({
                  title: "Plan ready for review",
                  body: `Session ${sessionId.substring(0, 8)} has a plan waiting for approval`,
                  sound: "Ping",
                });
              }

              // → error = agent errored (with category-aware title)
              if (status === "error") {
                const category = ws.session_error_category ?? undefined;
                track("session_error_displayed", {
                  session_id: sessionId,
                  error_category: category,
                });

                if (!isWindowFocused()) {
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
                    body:
                      ws.session_error_message ||
                      `Session ${sessionId.substring(0, 8)} encountered an error`,
                    sound: "Basso",
                  });
                }
              }
            }
          }

          // --- Setup status transitions ---
          const prevSetup = prevSetupStatusMap.current.get(ws.id);
          prevSetupStatusMap.current.set(ws.id, ws.setup_status);

          if (!prevSetup) continue;
          if (prevSetup === ws.setup_status) continue;

          if (
            prevSetup === "running" &&
            (ws.setup_status === "failed" || ws.setup_status === "completed")
          ) {
            track("workspace_setup_completed", {
              workspace_id: ws.id,
              setup_status: ws.setup_status,
            });
          }

          if (prevSetup === "running" && ws.setup_status === "failed" && !isWindowFocused()) {
            sendNotification({
              title: "Setup failed",
              body: `Workspace ${ws.title || ws.slug} setup failed${ws.error_message ? `: ${ws.error_message}` : ""}`,
              sound: "Basso",
            });
          }

          if (prevSetup === "running" && ws.setup_status === "completed") {
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
      unsubscribe();
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    };
  }, [queryClient]);
}
