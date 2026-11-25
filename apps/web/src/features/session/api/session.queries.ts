/**
 * Session Query Hooks
 * TanStack Query hooks for Claude Code session management
 */

import { useQuery, useMutation, useIsMutating, useQueryClient } from "@tanstack/react-query";
import { produce } from "immer";
import { api } from "@shared/api";
import type { PaginatedMessages } from "@shared/types/session";
import { queryKeys } from "@/shared/api/queryKeys";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { createOptimisticUserMessage, dropOptimisticMessage } from "../lib/optimisticMessage";
import { willQueueMessage } from "../lib/queuedMessages";
import { returnContentToComposer } from "../lib/returnToComposer";
import { composerStore } from "../store/sessionComposerStore";
import { patchWorkspaceSessionStatus } from "../lib/agentEventFold";
import {
  useIsDirectSession,
  isDirectSessionCached,
  sessionDetailQueryOptions,
} from "../cloud/useIsDirectSession";
import { getDirectSession } from "../cloud/directSessionRegistry";
import { uuidv7 } from "@shared/lib/uuid";
import type { Session, SessionStatus } from "../types";
import { track } from "@/platform/analytics";

import { call, connect, isConnected } from "@/platform/ws";
import { RuntimeError, runtimeForQueryClient } from "@/platform/ws/runtime-client";
import { emitSendAttemptFailed } from "@/features/connection";
import type { AgentHarness } from "@/shared/agents";

/**
 * Fetch all sessions for a workspace (used by chat tab reconstruction).
 * Stale time is high — tabs only hydrate on mount and after creating new sessions.
 */
export function useWorkspaceSessions(workspaceId: string | null) {
  useQuerySubscription(api.sessions, {
    queryKey: queryKeys.sessions.byWorkspace(workspaceId || ""),
    params: { workspaceId: workspaceId || "" },
    enabled: !!workspaceId,
  });

  return useQuery({
    queryKey: queryKeys.sessions.byWorkspace(workspaceId || ""),
    queryFn: () => call(api.sessions, { workspaceId: workspaceId! }),
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
  useQuerySubscription(api.session, {
    queryKey: queryKeys.sessions.detail(sessionId || ""),
    params: { sessionId: sessionId || "" },
    enabled: !!sessionId,
  });

  return useQuery({
    ...sessionDetailQueryOptions(sessionId || ""),
    enabled: !!sessionId,
  });
}

export function useQueuedMessages(sessionId: string) {
  const queryKey = queryKeys.sessions.queued(sessionId);
  const params = { sessionId };
  useQuerySubscription(api.queuedMessages, { queryKey, params });
  return useQuery({
    queryKey,
    queryFn: () => call(api.queuedMessages, params),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useEditQueuedMessage(sessionId: string) {
  const client = useQueryClient();
  const mutationKey = [api.queuedMessage.name, sessionId];
  const editing = useIsMutating({ mutationKey }) > 0;
  const { mutateAsync: edit } = useMutation({
    mutationKey,
    mutationFn: async (id: string) => {
      const host = runtimeForQueryClient(client) ?? { call };
      const store = composerStore(client);
      const params = { sessionId, id };
      const { content } = await host.call(api.queuedMessage, params);
      if (content === null) return;
      await returnContentToComposer(sessionId, content, store);
      await host.call(api.removeQueuedMessage, params);
    },
  });
  return { edit, editing };
}

/**
 * A session's transcript page.
 *
 * The page is read once. What happens to the chat afterwards is folded into
 * this cache from its `sessionEvents` stream (`useAgentEvents`), which follows
 * every chat with a page here; `useLoadOlderMessages` prepends history. The
 * virtualizer limits how many loaded messages render at once.
 */
export function useMessages(sessionId: string | null) {
  // Cloud-direct (Path B): the browser folds the agnt socket into this same
  // cache key itself (`useCloudDirect`), so the Mac-backend read must stand
  // down for a direct session, or an authoritative-empty fetch would clobber
  // the folded transcript. Direct mode is DERIVED here (not a threaded
  // param) so EVERY consumer respects it — including the composer mounted outside
  // SessionPanel's tree. `direct === false` is strict, so the unknown beat
  // (session row unloaded) holds the Mac lane DOWN: a wrongly-armed Mac lane
  // clobbers a fold; a wrongly-held one only delays a fetch by one round-trip.
  const direct = useIsDirectSession(sessionId);
  const macLaneEnabled = !!sessionId && direct === false;

  const query = useQuery({
    queryKey: queryKeys.sessions.messages(sessionId || ""),
    queryFn: () => call(api.messages, { sessionId: sessionId! }),
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
      call(api.messages, { sessionId, before: beforeSeq }),

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

export type SendMessageVariables = {
  sessionId: string;
  content: string;
  model: string;
  agentHarness: AgentHarness;
  permissionMode?: string;
  /** Every turn names one: a cloud turn without it is refused (AGNT chooses none). */
  thinkingLevel: string;
} & ({ mode?: undefined; turnId: string } | { mode: "steer"; turnId?: string });

/** A send predicts its echo when it expects to start a turn. The host decides whether it does. */
export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ mode, turnId, ...input }: SendMessageVariables) => {
      const { sessionId, content, model, agentHarness, thinkingLevel } = input;
      // Mac-CLOSED direct lane: a live direct channel means this session streams
      // straight from agnt, so its prompt goes there too — no Mac backend to relay
      // it, and no HTTP fallback (that path targets the same closed backend). The
      // optimistic bubble + the socket's echo reconcile it exactly as the q:delta
      // does on the Mac path; `sendMessage` throws if the socket is mid-reconnect,
      // which falls through to onError's rollback. No credential rides the wire —
      // agnt resolves the org key at dispatch.
      const direct = getDirectSession(sessionId, queryClient);
      if (direct && mode !== "steer") {
        direct.sendMessage(content, turnId, { model, agentHarness, thinkingLevel });
        return;
      }
      // A direct session whose channel isn't registered yet (socket mid-connect,
      // or a mint that failed): do NOT fall through to the Mac path below. That
      // relay is closed, and its HTTP fallback would dispatch a real turn whose
      // response the disarmed read-lanes can never render — a bubble stuck
      // forever. Reject so onError rolls it back deterministically.
      if (isDirectSessionCached(queryClient, sessionId)) {
        throw new Error("The cloud connection isn't ready yet — try again in a moment");
      }

      // Capture the cache's owner before waiting for connection. A host change
      // disposes this client; it cannot redirect the pending send to the new host.
      const backend = runtimeForQueryClient(queryClient) ?? { isConnected, connect, call };
      if (!backend.isConnected()) await backend.connect();
      if (mode === "steer") {
        await backend.call(api.steerMessage, { ...input, turnId });
        return;
      }
      return backend.call(api.sendMessage, { ...input, turnId });
    },

    onMutate: async ({ sessionId, content, model, turnId, mode }) => {
      const session = queryClient.getQueryData<Session>(queryKeys.sessions.detail(sessionId));
      // A busy local chat shows the host's queue until the engine echoes the message.
      if (mode === "steer" || willQueueMessage(session?.workspace_kind, session?.status)) return;
      await queryClient.cancelQueries({
        queryKey: queryKeys.sessions.messages(sessionId),
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

      const previousStatus = patchWorkspaceSessionStatus(queryClient, sessionId, "working");
      return { turnId, previousStatus };
    },

    onSuccess: (result, { sessionId }, optimistic) => {
      if (!result?.queued || !optimistic) return;
      dropOptimisticMessage(queryClient, sessionId, optimistic.turnId);
      void queryClient.invalidateQueries({ queryKey: ["workspaces", "by-repo"] });
    },

    onError: (error, { sessionId }, optimistic) => {
      // A failed or uncertain backend delivery should surface its connection
      // state. The cloud-direct channel owns its own connectivity UI, and a
      // runtime that was replaced (another host or account) says nothing about
      // the connection now in use.
      const owner = runtimeForQueryClient(queryClient);
      const replaced = owner && ["disposed", "revoked"].includes(owner.getState());
      const kind = error instanceof RuntimeError ? error.kind : undefined;
      if (
        (kind === "unavailable" || kind === "unknown-outcome") &&
        !replaced &&
        !isDirectSessionCached(queryClient, sessionId)
      ) {
        emitSendAttemptFailed();
      }
      if (optimistic) {
        dropOptimisticMessage(queryClient, sessionId, optimistic.turnId);
        const directFailure =
          kind === undefined &&
          (!!getDirectSession(sessionId, queryClient) ||
            isDirectSessionCached(queryClient, sessionId));
        if ((kind === "unavailable" || directFailure) && optimistic.previousStatus)
          patchWorkspaceSessionStatus(queryClient, sessionId, optimistic.previousStatus, "working");
      }
      void queryClient.invalidateQueries({ queryKey: ["workspaces", "by-repo"] });
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
    },
  });
}

/**
 * Stop session mutation
 */
export function useStopSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string): Promise<void> => {
      // Mac-CLOSED direct lane: cancel straight to agnt. The `turn.ended`
      // (cancelled) flows back over the render socket and the fold projects the
      // "Response stopped" divider — the same outcome the Mac stop produces.
      const direct = getDirectSession(sessionId, queryClient);
      if (direct) {
        direct.cancel();
        return;
      }
      // A pending direct connection must not fall back to the desktop command.
      if (isDirectSessionCached(queryClient, sessionId)) {
        throw new Error("The cloud connection isn't ready yet — try again in a moment");
      }
      await call(api.stopSession, { sessionId });
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
    mutationFn: (workspaceId: string) => call(api.createSession, { workspaceId }),
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
