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
 * - Workspace didn't start                                 → Basso sound
 *
 * A workspace that fails to start is the one event that also toasts in the
 * foreground: its failure is shown where its chat would be, which nobody is
 * looking at once they have moved on to another workspace. One that starts
 * records the chat it started with, which then tells the story of the start
 * under its first message (workspaceStartStore).
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
import { toast } from "sonner";
import { capabilities } from "@/platform/capabilities";
import { sendNotification } from "@/platform/notifications";
import { isWindowFocused } from "@/shared/hooks/useWindowFocus";
import { track } from "@/platform/analytics";
import { unreadActions } from "@/features/session/store/unreadStore";
import { openWorkspace } from "@/features/workspace/lib/openWorkspace";
import { useWorkspaceStore } from "@/features/workspace/store";
import { markStartedIn } from "@/features/workspace/store/workspaceStartStore";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { show as showWindow } from "@/platform/native/window";
import { openChat } from "@/features/session/lib/openChat";
import type { SessionStatus } from "@shared/types/session";
import {
  workspaceChats,
  type RepoGroup,
  type SetupStatus,
  type Workspace,
  type WorkspaceChat,
  type WorkspaceState,
} from "@shared/types/workspace";

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
  openChat(workspaceId, sessionId);
}

/**
 * Check if the user is currently viewing a specific session.
 * True when the workspace is selected AND the active chat tab matches the session.
 */
function checkIsViewingSession(ws: Workspace, sessionId: string): boolean {
  const selectedWorkspaceId = useWorkspaceStore.getState().selectedWorkspaceId;
  if (selectedWorkspaceId !== ws.id) return false;

  const layout = workspaceLayoutActions.getLayout(ws.id);
  // If no persisted active tab, the workspace's current_session_id is shown
  return (layout.activeChatTabSessionId ?? ws.current_session_id) === sessionId;
}

export function useGlobalSessionNotifications() {
  const prevSetupStatusMap = useRef(new Map<string, SetupStatus>());
  const prevStateMap = useRef(new Map<string, WorkspaceState>());
  const finishedBatch = useRef<FinishedEntry[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const queryClient = useQueryClient();

  useEffect(() => {
    let previous = new Map<string, SessionStatus>();
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
        const workspaces = new Set(batch.map((e) => e.workspaceId)).size;
        const body =
          repos.length === 1
            ? `${repos[0]} · ${workspaces} workspace${workspaces === 1 ? "" : "s"}`
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

    function sessionStatusChanged(ws: Workspace, repoName: string, chat: WorkspaceChat) {
      const { id: sessionId, status, error_category: errorCategory } = chat;
      const prevStatus = previous.get(sessionId);

      if (!prevStatus || prevStatus === status) return;

      if (
        (prevStatus === "working" || status === "error") &&
        !checkIsViewingSession(ws, sessionId)
      ) {
        unreadActions.markUnread(sessionId);
      }

      // working → idle = agent finished
      if (prevStatus === "working" && status === "idle") {
        track("ai_turn_completed", { session_id: sessionId });
        if (canNotify && !isWindowFocused()) {
          queueFinished({
            workspaceId: ws.id,
            sessionId,
            repoName,
            label: ws.title || ws.git_branch || ws.slug,
          });
        }
      }

      // → needs_response = agent needs user input
      if (status === "needs_response" && canNotify && !isWindowFocused()) {
        sendNotification({
          title: "Agent needs input",
          body: formatBody(repoName, ws),
          sound: "Ping",
          onClick: () => navigateToWorkspace(ws.id, sessionId),
        });
      }

      // → needs_plan_response = plan ready for review
      if (status === "needs_plan_response" && canNotify && !isWindowFocused()) {
        sendNotification({
          title: "Plan ready for review",
          body: formatBody(repoName, ws),
          sound: "Ping",
          onClick: () => navigateToWorkspace(ws.id, sessionId),
        });
      }

      // → error = agent errored (with category-aware title)
      if (status === "error") {
        const category = errorCategory ?? undefined;
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
            body: formatBody(repoName, ws),
            sound: "Basso",
            onClick: () => navigateToWorkspace(ws.id, sessionId),
          });
        }
      }
    }

    function queueFinished(entry: FinishedEntry) {
      finishedBatch.current.push(entry);
      if (!batchTimerRef.current) {
        batchTimerRef.current = setTimeout(flushFinishedBatch, BATCH_WINDOW_MS);
      }
    }

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const key = event.query.queryKey;
      if (key[0] !== "workspaces" || key[1] !== "by-repo") return;

      const groups = event.query.state.data as RepoGroup[] | undefined;
      if (!groups) return;

      const current = new Map<string, SessionStatus>();
      for (const group of groups) {
        for (const ws of group.workspaces) {
          for (const chat of workspaceChats(ws)) {
            current.set(chat.id, chat.status);
            sessionStatusChanged(ws, group.repo_name, chat);
          }

          // --- Start transitions ---
          const prevState = prevStateMap.current.get(ws.id);
          prevStateMap.current.set(ws.id, ws.state);

          // Local only: a cloud chat already tells its computer's story (cloud:env).
          // The start is told in the workspace's first chat, whatever chat is current.
          const firstChat = ws.first_session_id ?? ws.current_session_id;
          if (
            prevState === "initializing" &&
            ws.state === "ready" &&
            ws.kind !== "cloud" &&
            firstChat
          ) {
            markStartedIn(ws.id, firstChat);
          }

          function openFromNotification() {
            showWindow();
            openWorkspace(ws);
          }
          if (prevState === "initializing" && ws.state === "error") {
            if (!isWindowFocused()) {
              if (canNotify) {
                sendNotification({
                  title: "Workspace didn't start",
                  body: formatBody(group.repo_name, ws),
                  sound: "Basso",
                  onClick: openFromNotification,
                });
              }
            } else if (useWorkspaceStore.getState().selectedWorkspaceId !== ws.id) {
              toast.error(`${ws.title || ws.slug} didn't start`, {
                description: ws.error_message ?? undefined,
                duration: 10_000,
                action: { label: "View", onClick: openFromNotification },
              });
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
              onClick: openFromNotification,
            });
          }

          if (prevSetup === "running" && ws.setup_status === "completed") {
            queryClient.invalidateQueries({ queryKey: ["workspaces", "environment", ws.id] });
            if (canNotify && !isWindowFocused()) {
              sendNotification({
                title: "Setup complete",
                body: formatBody(group.repo_name, ws),
                sound: "Glass",
                onClick: openFromNotification,
              });
            }
          }
        }
      }
      previous = current;
    });

    return () => {
      unsubscribe();
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    };
  }, [queryClient]);
}
