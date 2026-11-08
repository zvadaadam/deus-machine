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
import { SendRejectedError, rollbackSendStatus } from "../lib/sendRollback";
import {
  useIsDirectSession,
  isDirectSessionCached,
  sessionDetailQueryOptions,
} from "../cloud/useIsDirectSession";
import { getDirectSession } from "../cloud/directSessionRegistry";
import { uuidv7 } from "@shared/lib/uuid";
import type { Message, Session, SessionStatus } from "../types";
import type { RepoGroup } from "@shared/types/workspace";
import { useEffect, useMemo } from "react";
import { track } from "@/platform/analytics";

import { sendCommand, connect, isConnected } from "@/platform/ws";
import { RuntimeError, runtimeForQueryClient } from "@/platform/ws/runtime-client";
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
    ...sessionDetailQueryOptions(sessionId || ""),
    enabled: !!sessionId,
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
  const runtime = runtimeForQueryClient(queryClient);
  const stableKey = useMemo(() => sessionIds.join(","), [sessionIds]);
  useEffect(() => {
    if (!sessionIds.length || !runtime) return;
    const unsubs = sessionIds.map((id) =>
      runtime.retainQuery("session", { sessionId: id }, queryKeys.sessions.detail(id))
    );
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableKey, runtime]);

  const queries = useQueries({
    queries: sessionIds.map((id) => ({
      ...sessionDetailQueryOptions(id),
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
 * HTTP queryFn loads the latest page; useLoadOlderMessages prepends history.
 * The virtualizer limits how many loaded messages render at once.
 */
export function useMessages(sessionId: string | null) {
  // Cloud-direct (Path B): the browser folds the agnt socket into this same
  // cache key itself (`useCloudDirect`), so the Mac-backend lanes — the WS
  // `messages` subscription, the reconnect-invalidate, and the HTTP fetch — must
  // all stand down for a direct session, or an authoritative-empty fetch would
  // clobber the folded transcript. Direct mode is DERIVED here (not a threaded
  // param) so EVERY consumer respects it — including the composer mounted outside
  // SessionPanel's tree. `direct === false` is strict, so the unknown beat
  // (session row unloaded) holds the Mac lane DOWN: a wrongly-armed Mac lane
  // clobbers a fold; a wrongly-held one only delays a fetch by one round-trip.
  const direct = useIsDirectSession(sessionId);
  const macLaneEnabled = !!sessionId && direct === false;

  useQuerySubscription("messages", {
    queryKey: queryKeys.sessions.messages(sessionId || ""),
    params: { sessionId: sessionId || "" },
    enabled: macLaneEnabled,
    mergeDelta: mergeMessageDelta,
  });

  // The runtime-owned agent subscription recovers cached transcripts on reconnect.

  const query = useQuery({
    queryKey: queryKeys.sessions.messages(sessionId || ""),
    queryFn: () => SessionService.fetchMessages(sessionId!),
    enabled: macLaneEnabled,
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
  const queryClient = useQueryClient();
  const sessionQuery = useSession(sessionId);
  const messagesQuery = useMessages(sessionId);

  const messages = messagesQuery.data?.messages ?? [];
  const compactions = messagesQuery.data?.compactions;
  const turns = messagesQuery.data?.turns;
  const hasOlder = messagesQuery.data?.has_older ?? false;

  return {
    session: sessionQuery.data,
    messages,
    compactions,
    turns,
    hasOlder,
    sessionStatus: (sessionQuery.data?.status as SessionStatus) || "idle",
    loading: sessionQuery.isLoading || messagesQuery.isLoading,
    error: sessionQuery.error || messagesQuery.error,
    // Invalidation respects disabled queries: cloud-direct history must never
    // fall back to the desktop's REST projection, even on a manual retry.
    retry: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId || "") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.messages(sessionId || "") }),
      ]),
  };
}

/**
 * Load older messages — button-triggered, not scroll-triggered.
 * Prepends older messages to the cache. No cooldown, no scroll restoration.
 */
export function useLoadOlderMessages() {
  const queryClient = useQueryClient();

  return useMutation({
    onMutate: ({ sessionId }) =>
      new Map(
        queryClient
          .getQueryData<PaginatedMessages>(queryKeys.sessions.messages(sessionId))
          ?.turns.map((turn) => [turn.turnId, turn])
      ),
    mutationFn: ({ sessionId, beforeSeq }: { sessionId: string; beforeSeq: number }) =>
      SessionService.fetchMessages(sessionId, { before: beforeSeq }),

    onSuccess: (olderPage, { sessionId }, turnsAtRequest) => {
      queryClient.setQueryData<PaginatedMessages>(queryKeys.sessions.messages(sessionId), (old) => {
        if (!old) return olderPage;
        const existingIds = new Set(old.messages.map((m) => m.id));
        const newMessages = olderPage.messages.filter((m) => !existingIds.has(m.id));
        const turns = new Map(old.turns.map((turn) => [turn.turnId, turn]));
        for (const turn of olderPage.turns) {
          // Refresh cached history, but preserve live updates received during the fetch.
          const current = turns.get(turn.turnId);
          if (!current || current === turnsAtRequest?.get(turn.turnId)) {
            turns.set(turn.turnId, turn);
          }
        }
        return {
          messages: [...newMessages, ...old.messages],
          // The older page carries the session's full compaction list
          // (single digits, never paginated), so it is simply the fresher one.
          compactions: olderPage.compactions,
          turns: [...turns.values()],
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
  /** Every turn names one: a cloud turn without it is refused (AGNT chooses none). */
  thinkingLevel: string;
}

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
      // Mac-CLOSED direct lane: a live direct channel means this session streams
      // straight from agnt, so its prompt goes there too — no Mac backend to relay
      // it, and no HTTP fallback (that path targets the same closed backend). The
      // optimistic bubble + the socket's echo reconcile it exactly as the q:delta
      // does on the Mac path; `sendMessage` throws if the socket is mid-reconnect,
      // which falls through to onError's rollback. No credential rides the wire —
      // agnt resolves the org key at dispatch.
      const direct = getDirectSession(sessionId, queryClient);
      if (direct) {
        direct.sendMessage(content, turnId, { model, agentHarness, thinkingLevel });
        return;
      }
      // A direct session whose channel isn't registered yet (socket mid-connect,
      // or a mint that failed): do NOT fall through to the Mac path below. That
      // relay is closed, and its HTTP fallback would dispatch a real turn whose
      // response the disarmed read-lanes can never render — a bubble stuck
      // forever. Reject so onError rolls it back deterministically.
      if (isDirectSessionCached(queryClient, sessionId)) {
        throw new SendRejectedError("The cloud connection isn't ready yet — try again in a moment");
      }

      // Capture the cache's owner before waiting for connection. A host change
      // disposes this client; it cannot redirect the pending send to the new host.
      const backend = runtimeForQueryClient(queryClient) ?? { isConnected, connect, sendCommand };
      if (!backend.isConnected()) await backend.connect();
      const ack = await backend.sendCommand("sendMessage", {
        sessionId,
        content,
        model,
        agentHarness,
        turnId,
        permissionMode,
        thinkingLevel,
      });
      if (!ack.accepted) throw new SendRejectedError(ack.error || "Agent rejected the query");
      // No fallback resubmission: a lost ACK can follow a successfully started turn.
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
            turns: [],
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
      // A failed or uncertain backend delivery should surface its connection
      // state. The cloud-direct channel owns its own connectivity UI, and a
      // runtime that was replaced (another host or account) says nothing about
      // the connection now in use.
      const owner = runtimeForQueryClient(queryClient);
      const replaced = owner && ["disposed", "revoked"].includes(owner.getState());
      if (
        _err instanceof Error &&
        !replaced &&
        !isDirectSessionCached(queryClient, variables.sessionId)
      ) {
        const msg = _err.message.toLowerCase();
        if (
          (_err instanceof RuntimeError &&
            (_err.kind === "unavailable" || _err.kind === "unknown-outcome")) ||
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
      // Put the sidebar's status back — by REFETCH after a server rejection,
      // or uncertain delivery, and by snapshot only for failures before dispatch.
      // See sendRollback.ts.
      rollbackSendStatus(queryClient, _err, context?.previousWorkspaceByRepo);
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
    mutationFn: (sessionId: string) => {
      // Mac-CLOSED direct lane: cancel straight to agnt. The `turn.ended`
      // (cancelled) flows back over the render socket and the fold projects the
      // "Response stopped" divider — the same outcome the Mac stop produces.
      const direct = getDirectSession(sessionId, queryClient);
      if (direct) {
        direct.cancel();
        return Promise.resolve();
      }
      // A pending direct connection must not fall back to the desktop command.
      if (isDirectSessionCached(queryClient, sessionId)) {
        throw new Error("The cloud connection isn't ready yet — try again in a moment");
      }
      return SessionService.stop(sessionId);
    },
    onSuccess: (_, sessionId) => {
      const session = queryClient.getQueryData<Session>(queryKeys.sessions.detail(sessionId));
      track("session_stopped", {
        session_id: sessionId,
        agent_harness: session?.agent_harness,
      });
      // Direct sessions project their terminal state from the stream; a local
      // detail fetch can overwrite it with a stale desktop row.
      if (!isDirectSessionCached(queryClient, sessionId)) {
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
      }
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
