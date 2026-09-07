/**
 * useAgentEvents — subscribe to the canonical agent stream and fold it.
 *
 * The backend forwards every @zvada/agent-server lifecycle envelope verbatim
 * as `agent:event`; `agent:snapshot` replaces the fold after cloud recovery.
 * This hook owns only the browser-shaped parts
 * of consuming it — the socket subscription, the animation-frame delta flush
 * and the debounced page reload. The fold itself lives in `lib/agentEventFold`,
 * so it can be tested without React, a DOM or a socket.
 *
 * The subscription is global (one socket, all sessions), and so is the fold:
 * envelopes for OTHER sessions still patch their cached pages, because a
 * `turn.ended` is an UPDATE — tokens, cost, turn_stop_reason, cancelled_at —
 * and the delta-only `messages` subscription can only carry INSERTs. Without
 * that, starting a turn and switching tabs left the footer permanently blank.
 */

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { onEvent } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import type { AgentConversationSnapshot } from "@shared/cloud-session-snapshot";
import { isCloudDirectEnabled } from "../cloud/cloudDirectFlag";
import { isDirectSessionCached } from "../cloud/useIsDirectSession";
import {
  createStreamCursor,
  flushDeltas,
  hydrateConversation,
  messagesKey,
  pruneFolds,
  refetchMessages,
  routeEnvelope,
  type AgentStreamContext,
  type SessionFold,
} from "../lib/agentEventFold";

/** A burst of gaps must not become a burst of full-page refetches. */
const REFETCH_DEBOUNCE_MS = 250;

// One fold and cursor per window, retained across shell remounts. The shell
// owns the listener so collapsed chat and settings still receive recovery.
const folds = new Map<string, SessionFold>();
const cursor = createStreamCursor();

export function subscribeToAgentEvents(queryClient: QueryClient): () => void {
  pruneFolds(queryClient, folds);
  let frame: number | null = null;
  const refetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function usesBackend(sessionId: string): boolean {
    return (
      !isCloudDirectEnabled() ||
      (!!queryClient.getQueryData(queryKeys.sessions.detail(sessionId)) &&
        !isDirectSessionCached(queryClient, sessionId))
    );
  }

  const ctx: AgentStreamContext = {
    queryClient,
    activeSessionId: null,
    folds,
    cursor,
    scheduleFlush: () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        for (const [sessionId, fold] of folds) {
          if (usesBackend(sessionId)) flushDeltas(queryClient, sessionId, fold);
        }
      });
    },
    requestRefetch: (target) => {
      clearTimeout(refetchTimers.get(target));
      refetchTimers.set(
        target,
        setTimeout(() => {
          refetchTimers.delete(target);
          if (usesBackend(target)) void refetchMessages(queryClient, target);
        }, REFETCH_DEBOUNCE_MS)
      );
    },
  };

  const unsub = onEvent((name: string, raw: unknown) => {
    if (name !== "agent:snapshot" && name !== "agent:event") return;
    const sessionId = (raw as { sessionId?: string })?.sessionId;
    // Disabled observers also exist for direct/unknown sessions. Only the
    // confirmed backend lane may write, including deferred work above.
    if (!sessionId || !usesBackend(sessionId)) return;
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: messagesKey(sessionId), exact: true });
    ctx.activeSessionId = query?.getObserversCount() ? sessionId : null;
    if (name === "agent:snapshot") {
      const snapshot = raw as AgentConversationSnapshot;
      clearTimeout(refetchTimers.get(snapshot.sessionId));
      refetchTimers.delete(snapshot.sessionId);
      hydrateConversation(ctx, snapshot);
      return;
    }
    routeEnvelope(ctx, raw as DecodedWireEventEnvelope);
  });

  const unsubCache = queryClient.getQueryCache().subscribe((event) => {
    const [scope, resource, sessionId] = event.query.queryKey;
    if (event.type === "removed" && scope === "sessions" && resource === "messages") {
      folds.delete(sessionId as string);
    }
  });

  return () => {
    unsub();
    unsubCache();
    if (frame !== null) cancelAnimationFrame(frame);
    refetchTimers.forEach((timer) => clearTimeout(timer));
    refetchTimers.clear();
  };
}

export function useAgentEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => subscribeToAgentEvents(queryClient), [queryClient]);
}
