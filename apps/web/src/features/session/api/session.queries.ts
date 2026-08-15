/**
 * Session Query Hooks
 * TanStack Query hooks for Claude Code session management
 */

import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { produce } from "immer";
import { SessionService } from "./session.service";
import type { PaginatedMessages } from "./session.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { mergeMessageDelta } from "../lib/messageCache";
import { createOptimisticUserMessage, dropOptimisticMessage } from "../lib/optimisticMessage";
import { uuidv7 } from "@shared/lib/uuid";
import type { Message, Session, SessionStatus } from "../types";
import type { RepoGroup } from "@shared/types/workspace";
import { useEffect, useMemo, useRef } from "react";
import { track } from "@/platform/analytics";

import { sendCommand, connect, isConnected, subscribe, onConnectionChange } from "@/platform/ws";
import { emitSendAttemptFailed } from "@/features/connection";
import type { AgentHarness } from "@/shared/agents";

/**
 * Fetch all sessions for a workspace (used by chat tab reconstruction).
 * Stale time is high — tabs only hydrate on mount and after creating new sessions.
 */
export function useWorkspaceSessions(workspaceId: string | null) {
  useQuerySubscription("sessions", {
    queryKey: queryKeys.sessions.byWorkspace(workspaceId || ""),
    params: { workspaceId: workspaceId || "" },
    enabled: !!workspaceId,
  });

  return useQuery({
    queryKey: queryKeys.sessions.byWorkspace(workspaceId || ""),
    queryFn: () => SessionService.fetchByWorkspace(workspaceId!),
    enabled: !!workspaceId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch session details — fully WS-driven, no polling.
 *
 * Updates come from WS subscription: backend pushes q:snapshot on
 * session:status, session:updated, and session:message notifications.
 * HTTP queryFn is fallback for initial load before WS connects.
 */
export function useSession(sessionId: string | null) {
  useQuerySubscription("session", {
    queryKey: queryKeys.sessions.detail(sessionId || ""),
    params: { sessionId: sessionId || "" },
    enabled: !!sessionId,
  });

  return useQuery({
    queryKey: queryKeys.sessions.detail(sessionId || ""),
    queryFn: () => SessionService.fetchById(sessionId!),
    enabled: !!sessionId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/**
 * Subscribe to per-session working status for multiple sessions at once.
 * Used by the tab bar to show per-tab spinners and unread detection.
 *
 * Subscribes each session to WS push so status transitions arrive in real
 * time — even for non-active tabs. Without this, only the active tab
 * (via useSession) receives WS updates; background tabs rely on stale
 * HTTP cache and never trigger unread detection.
 */
export function useWorkingSessionIds(sessionIds: string[]): Set<string> {
  const queryClient = useQueryClient();

  // WS-subscribe all tab sessions so status pushes keep the cache fresh.
  const stableKey = useMemo(() => sessionIds.join(","), [sessionIds]);
  useEffect(() => {
    if (!sessionIds.length) return;
    const unsubs = sessionIds.map((id) =>
      subscribe("session", { sessionId: id }, (data) => {
        queryClient.setQueryData(queryKeys.sessions.detail(id), data);
      })
    );
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableKey, queryClient]);

  const queries = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: queryKeys.sessions.detail(id),
      queryFn: () => SessionService.fetchById(id),
      staleTime: Infinity, // WS handles freshness now
      refetchOnWindowFocus: false,
      select: (data: Session): SessionStatus => data.status,
    })),
  });

  return useMemo(() => {
    const ids = new Set<string>();
    sessionIds.forEach((id, i) => {
      if (queries[i]?.data === "working") ids.add(id);
    });
    return ids;
  }, [queries, sessionIds]);
}

/**
 * Fetch messages for a session — fully WS-driven.
 *
 * WS subscription pushes q:delta frames with new messages since last cursor.
 * mergeMessageDelta handles the PaginatedMessages shape, deduplication,
 * and optimistic placeholder cleanup.
 * HTTP queryFn loads all messages (backend caps at 2000). No pagination —
 * the virtualizer handles render-level windowing.
 */
export function useMessages(sessionId: string | null) {
  const queryClient = useQueryClient();

  useQuerySubscription("messages", {
    queryKey: queryKeys.sessions.messages(sessionId || ""),
    params: { sessionId: sessionId || "" },
    enabled: !!sessionId,
    mergeDelta: mergeMessageDelta,
  });

  // On WS reconnect, refetch messages to catch up on anything missed
  // while disconnected. The delta-only subscription resets its cursor
  // to MAX(seq) on re-subscribe, so messages written during downtime
  // would be permanently skipped without this.
  const hasConnectedOnce = useRef(false);
  useEffect(() => {
    if (!sessionId) return;
    return onConnectionChange((connected) => {
      if (connected) {
        if (hasConnectedOnce.current) {
          queryClient.invalidateQueries({ queryKey: queryKeys.sessions.messages(sessionId) });
        }
        hasConnectedOnce.current = true;
      }
    });
  }, [sessionId, queryClient]);

  const query = useQuery({
    queryKey: queryKeys.sessions.messages(sessionId || ""),
    queryFn: () => SessionService.fetchMessages(sessionId!),
    enabled: !!sessionId,
    refetchInterval: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return query;
}

/**
 * Combined hook for session + messages + status
 */
export function useSessionWithMessages(sessionId: string | null) {
  const sessionQuery = useSession(sessionId);
  const messagesQuery = useMessages(sessionId);

  const messages = messagesQuery.data?.messages ?? [];
  const compactions = messagesQuery.data?.compactions;
  const hasOlder = messagesQuery.data?.has_older ?? false;

  return {
    session: sessionQuery.data,
    messages,
    compactions,
    hasOlder,
    sessionStatus: (sessionQuery.data?.status as SessionStatus) || "idle",
    loading: sessionQuery.isLoading || messagesQuery.isLoading,
    error: sessionQuery.error || messagesQuery.error,
  };
}

/**
 * Load older messages — button-triggered, not scroll-triggered.
 * Prepends older messages to the cache. No cooldown, no scroll restoration.
 */
export function useLoadOlderMessages() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, beforeSeq }: { sessionId: string; beforeSeq: number }) =>
      SessionService.fetchMessages(sessionId, { before: beforeSeq }),

    onSuccess: (olderPage, { sessionId }) => {
      queryClient.setQueryData<PaginatedMessages>(queryKeys.sessions.messages(sessionId), (old) => {
        if (!old) return olderPage;
        const existingIds = new Set(old.messages.map((m) => m.id));
        const newMessages = olderPage.messages.filter((m) => !existingIds.has(m.id));
        return {
          messages: [...newMessages, ...old.messages],
          // The older page carries the session's full compaction list
          // (single digits, never paginated) — take the fresher one.
          compactions: olderPage.compactions ?? old.compactions,
          has_older: olderPage.has_older,
          has_newer: old.has_newer,
        };
      });
    },
  });
}

/** A send's correlation key: the optimistic bubble and the engine's echo. */
export function newTurnId(): string {
  return uuidv7();
}

export interface SendMessageVariables {
  sessionId: string;
  content: string;
  model: string;
  agentHarness: AgentHarness;
  /** Minted by the caller with `newTurnId()` — see useSessionActions. */
  turnId: string;
  permissionMode?: string;
  thinkingLevel?: string;
}

/** A rejection the server understood — resending it would only reject again. */
class SendRejectedError extends Error {}

/**
 * Send message mutation with optimistic update.
 *
 * The caller mints the turn id and it travels BOTH ways: into the command
 * params (the backend uses it as the engine's `turnId`) and onto the optimistic
 * bubble's `turn_id`. That is what lets the engine's user echo
 * (`message.started{role:"user"}`) replace the bubble in place instead of
 * appending a second one — the reconciliation is keyed on that id, so it has
 * to exist before the send, not after.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      content,
      model,
      agentHarness,
      turnId,
      permissionMode,
      thinkingLevel,
    }: SendMessageVariables): Promise<Message | void> => {
      // Send message via WS command: backend flips the session to working,
      // forwards to agent-server, and pushes q:delta to subscribers.
      try {
        if (!isConnected()) await connect();
        const ack = await sendCommand("sendMessage", {
          sessionId,
          content,
          model,
          agentHarness,
          turnId,
          permissionMode,
          thinkingLevel,
        });
        if (!ack.accepted) {
          // A business rejection ("the agent is still working"). The HTTP
          // fallback below would send the SAME command down the SAME socket
          // and be rejected identically — or, if the status raced, actually
          // start a second turn. Fail here so onError rolls the bubble back
          // deterministically instead of leaving it for an unrelated delta.
          throw new SendRejectedError(ack.error || "Agent rejected the query");
        }
        // No return value needed — WS q:delta handles message reconciliation.
        return;
      } catch (error) {
        if (error instanceof SendRejectedError) throw error;
        // Transport failure only: fall back through the legacy service wrapper,
        // keeping the same runtime routing fields so backend validation
        // behaves identically.
        return SessionService.sendMessage(sessionId, content, model, agentHarness, turnId);
      }
    },

    // Optimistic update: show user message immediately.
    // Status indicators (tab spinner, sidebar) are updated by the workspaces
    // WS subscription — the agent-server notifies the backend, which pushes fresh
    // workspace snapshots within ~50ms.
    onMutate: async ({ sessionId, content, model, turnId }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.sessions.messages(sessionId),
      });

      // Snapshot workspace-by-repo cache before optimistic update so we can
      // restore the exact prior status on error (instead of hardcoding "idle").
      const previousWorkspaceByRepo = queryClient.getQueriesData<RepoGroup[]>({
        queryKey: ["workspaces", "by-repo"],
      });

      // The bubble carries the send's turn id and engine `Part`s — the same
      // shapes the echo will restate, through the same render path.
      const optimisticMessage = createOptimisticUserMessage({
        sessionId,
        turnId,
        content,
        model,
      });

      queryClient.setQueryData<PaginatedMessages>(queryKeys.sessions.messages(sessionId), (old) => {
        if (!old)
          return {
            messages: [optimisticMessage],
            compactions: [],
            has_older: false,
            has_newer: false,
          };
        return produce(old, (draft) => {
          draft.messages.push(optimisticMessage);
        });
      });

      // Optimistically set workspace status to "working" in sidebar cache.
      // Handles the startup race where the first IPC event arrives before
      // the workspace list has loaded (cache empty → event matching fails).
      queryClient.setQueriesData<RepoGroup[]>({ queryKey: ["workspaces", "by-repo"] }, (old) => {
        if (!old) return old;
        return old.map((group) => ({
          ...group,
          workspaces: group.workspaces.map((ws) =>
            ws.current_session_id === sessionId
              ? { ...ws, session_status: "working" as SessionStatus }
              : ws
          ),
        }));
      });

      return { previousWorkspaceByRepo };
    },

    onError: (_err, variables, context) => {
      // If the error is a WS connectivity issue, escalate the connection state
      // immediately. The WS client produces three distinct error messages:
      //   "WebSocket not connected"     — socket already down before send
      //   "WebSocket disconnected"      — connection dropped mid-flight
      //   "WebSocket connection failed" — connect() rejected (initial open failed)
      if (_err instanceof Error) {
        const msg = _err.message.toLowerCase();
        if (
          msg.includes("not connected") ||
          msg.includes("disconnected") ||
          msg.includes("connection failed")
        ) {
          emitSendAttemptFailed();
        }
      }
      // Retire THIS send's bubble, and only it — the toast above is the user's
      // notice, and the row must not linger pretending the prompt was sent.
      dropOptimisticMessage(queryClient, variables.sessionId, variables.turnId);
      // Roll back optimistic workspace status from snapshot
      if (context?.previousWorkspaceByRepo?.length) {
        context.previousWorkspaceByRepo.forEach(([key, data]) => {
          queryClient.setQueryData(key, data);
        });
      } else {
        queryClient.invalidateQueries({ queryKey: ["workspaces", "by-repo"] });
      }
    },

    onSettled: async (_, error, variables) => {
      if (!error) {
        const hasImages = (() => {
          try {
            const parsed = JSON.parse(variables.content);
            return (
              Array.isArray(parsed) && parsed.some((b: { type?: string }) => b.type === "image")
            );
          } catch {
            return false;
          }
        })();
        const session = queryClient.getQueryData<Session>(
          queryKeys.sessions.detail(variables.sessionId)
        );
        track("session_message_sent", {
          session_id: variables.sessionId,
          has_images: hasImages,
          model: variables.model,
          agent_harness: session?.agent_harness,
          message_count: session?.message_count,
          context_used_percent: session?.context_used_percent,
        });
      }
      // No incrementalFetchAndMerge needed — WS q:delta handles reconciliation.
      // The optimistic message stays visible until the delta arrives with the real message.
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
      const session = queryClient.getQueryData<Session>(queryKeys.sessions.detail(sessionId));
      track("session_stopped", {
        session_id: sessionId,
        agent_harness: session?.agent_harness,
      });
      // Immediate invalidation for snappy UI feedback.
      // Backend also pushes via WS q:invalidate. React Query deduplicates.
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.detail(sessionId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.all,
      });
    },
  });
}

/**
 * Create a new session for a workspace.
 * Used when user opens a new chat tab (Cmd+T).
 * Backend creates the session and updates workspace.current_session_id.
 */
export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => SessionService.createSession(workspaceId),
    onSuccess: (newSession, workspaceId) => {
      track("session_created", {
        workspace_id: workspaceId,
        agent_harness: newSession?.agent_harness,
      });
      // Immediate invalidation for snappy UI feedback.
      // Backend also pushes via WS q:invalidate. React Query deduplicates.
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.all,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(workspaceId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.byWorkspace(workspaceId),
      });
    },
  });
}
