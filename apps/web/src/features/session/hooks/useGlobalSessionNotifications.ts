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
 * which is kept fresh by the WS subscription. No IPC event listeners needed.
 *
 * When the app is in the foreground, notifications are suppressed —
 * Sonner toasts handle in-app feedback.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { match } from "ts-pattern";
import { capabilities } from "@/platform/capabilities";
import { sendNotification } from "@/platform/notifications";
import { isWindowFocused } from "@/shared/hooks/useWindowFocus";
import { track } from "@/platform/analytics";
import { unreadActions } from "@/features/session/store/unreadStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
} from "@/features/workspace/store/workspaceLayoutStore";
import { show as showWindow } from "@/platform/native/window";
import type { SessionStatus } from "@shared/types/session";
import type { RepoGroup, SetupStatus, Workspace } from "@shared/types/workspace";

/**
 * Batches multiple notifications within a short window into a single one.
 * Prevents notification spam when multiple agents finish simultaneously.
 */
const BATCH_WINDOW_MS = 1500;

interface FinishedEntry {
  workspaceId: string;
  sessionId: string;
  repoName: string;
  label: string;
}

function formatBody(repoName: string, ws: Workspace): string {
  const label = ws.title || ws.git_branch || ws.slug;
  return `${repoName} · ${label}`;
}

function navigateToWorkspace(workspaceId: string, sessionId: string): void {
  showWindow();
  useWorkspaceStore.getState().selectWorkspace(workspaceId);
  // Only update chat tabs if workspace has existing layout state.
  // Stale notification clicks (workspace archived) skip this to avoid orphaned entries.
  const existing = useWorkspaceLayoutStore.getState().layouts[workspaceId];
  if (!existing || existing.activeChatTabSessionId === sessionId) return;
  const sessionIds = existing.chatTabSessionIds.includes(sessionId)
    ? existing.chatTabSessionIds
    : [...existing.chatTabSessionIds, sessionId];
  workspaceLayoutActions.setChatTabState(workspaceId, sessionIds, sessionId);
}

/**
 * Check if the user is currently viewing a specific session.
 * True when the workspace is selected AND the active chat tab matches the session.
 */
function checkIsViewingSession(workspaceId: string, sessionId: string): boolean {
  const selectedWorkspaceId = useWorkspaceStore.getState().selectedWorkspaceId;
  if (selectedWorkspaceId !== workspaceId) return false;

  const layout = workspaceLayoutActions.getLayout(workspaceId);
  // If no persisted active tab, the workspace's current_session_id is shown
  return layout.activeChatTabSessionId === sessionId || !layout.activeChatTabSessionId;
}

export function useGlobalSessionNotifications() {
  const prevStatusMap = useRef(new Map<string, SessionStatus>());
  const prevSetupStatusMap = useRef(new Map<string, SetupStatus>());
  const finishedBatch = useRef<FinishedEntry[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const queryClient = useQueryClient();

  useEffect(() => {
    const canNotify = capabilities.nativeNotifications;

    function flushFinishedBatch() {
      const batch = finishedBatch.current;
      finishedBatch.current = [];
      batchTimerRef.current = undefined;

      if (batch.length === 0 || isWindowFocused()) return;

      if (batch.length === 1) {
        const entry = batch[0];
        sendNotification({
          title: "Agent finished",
          body: `${entry.repoName} · ${entry.label}`,
          sound: "Glass",
          onClick: () => navigateToWorkspace(entry.workspaceId, entry.sessionId),
        });
      } else {
        const repos = [...new Set(batch.map((e) => e.repoName))];
        const body =
          repos.length === 1
            ? `${repos[0]} · ${batch.length} workspaces`
            : `${repos[0]} + ${repos.length - 1} more`;
        const first = batch[0];
        sendNotification({
          title: `${batch.length} agents finished`,
          body,
          sound: "Glass",
          onClick: () => navigateToWorkspace(first.workspaceId, first.sessionId),
        });
      }
    }

    function queueFinished(entry: FinishedEntry) {
      finishedBatch.current.push(entry);
      if (!batchTimerRef.current) {
        batchTimerRef.current = setTimeout(flushFinishedBatch, BATCH_WINDOW_MS);
      }
    }

    // Detect session + setup transitions from the workspace query cache.
    // Only watches current_session_id per workspace. Non-current sessions
    // (extra tabs) are handled by ChatArea which tracks workingSessionIds.
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
              // Mark session as unread when transitioning out of "working"
              // to any terminal state — but only if user is not currently
              // viewing that exact session.
              if (
                prevStatus === "working" &&
                (status === "idle" ||
                  status === "error" ||
                  status === "needs_response" ||
                  status === "needs_plan_response")
              ) {
                const isViewingSession = checkIsViewingSession(ws.id, sessionId);
                if (!isViewingSession) {
                  unreadActions.markUnread(sessionId);
                }
              }

              // working → idle = agent finished
              if (prevStatus === "working" && status === "idle") {
                track("ai_turn_completed", { session_id: sessionId });
                if (canNotify && !isWindowFocused()) {
                  queueFinished({
                    workspaceId: ws.id,
                    sessionId,
                    repoName: group.repo_name,
                    label: ws.title || ws.git_branch || ws.slug,
                  });
                }
              }

              // → needs_response = agent needs user input
              if (status === "needs_response" && canNotify && !isWindowFocused()) {
                sendNotification({
                  title: "Agent needs input",
                  body: formatBody(group.repo_name, ws),
                  sound: "Ping",
                  onClick: () => navigateToWorkspace(ws.id, sessionId),
                });
              }

              // → needs_plan_response = plan ready for review
              if (status === "needs_plan_response" && canNotify && !isWindowFocused()) {
                sendNotification({
                  title: "Plan ready for review",
                  body: formatBody(group.repo_name, ws),
                  sound: "Ping",
                  onClick: () => navigateToWorkspace(ws.id, sessionId),
                });
              }

              // → error = agent errored (with category-aware title)
              if (status === "error") {
                const category = ws.session_error_category ?? undefined;
                track("session_error_displayed", {
                  session_id: sessionId,
                  error_category: category,
                });

                if (canNotify && !isWindowFocused()) {
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
                    body: formatBody(group.repo_name, ws),
                    sound: "Basso",
                    onClick: () => navigateToWorkspace(ws.id, sessionId),
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

          if (
            prevSetup === "running" &&
            ws.setup_status === "failed" &&
            canNotify &&
            !isWindowFocused()
          ) {
            sendNotification({
              title: "Setup failed",
              body: formatBody(group.repo_name, ws),
              sound: "Basso",
              onClick: () => {
                showWindow();
                useWorkspaceStore.getState().selectWorkspace(ws.id);
              },
            });
          }

          if (prevSetup === "running" && ws.setup_status === "completed") {
            queryClient.invalidateQueries({ queryKey: ["workspaces", "manifest", ws.id] });
            if (canNotify && !isWindowFocused()) {
              sendNotification({
                title: "Setup complete",
                body: formatBody(group.repo_name, ws),
                sound: "Glass",
                onClick: () => {
                  showWindow();
                  useWorkspaceStore.getState().selectWorkspace(ws.id);
                },
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
