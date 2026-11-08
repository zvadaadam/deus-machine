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
 * The subscription and fold belong to one runtime and cover all its sessions:
 * envelopes for OTHER sessions still patch their cached pages, because
 * turn records change when a turn starts or ends, while the delta-only
 * `messages` subscription only carries new messages. Without
 * that, starting a turn and switching tabs left the footer permanently blank.
 */

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { onEvent } from "@/platform/ws";
import { runtimeForQueryClient } from "@/platform/ws/runtime-client";
import { queryKeys } from "@/shared/api/queryKeys";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import type { AgentConversationSnapshot } from "@shared/cloud-session-snapshot";
import { isCloudDirectEnabled } from "../cloud/cloudDirectFlag";
import { isDirectSessionCached } from "../cloud/useIsDirectSession";
import { notifyCloudAutosaveFailure } from "../cloud/notifyCloudAutosaveFailure";
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

// A cache belongs to one authenticated runtime. Retain across shell remounts,
// never across a host/grant change, even when two hosts reuse the same session ID.
const projections = new WeakMap<
  QueryClient,
  {
    folds: Map<string, SessionFold>;
    cursor: ReturnType<typeof createStreamCursor>;
  }
>();

export function subscribeToAgentEvents(queryClient: QueryClient): () => void {
  let projection = projections.get(queryClient);
  if (!projection) {
    projection = { folds: new Map(), cursor: createStreamCursor() };
    projections.set(queryClient, projection);
  }
  const { folds, cursor } = projection;
  const runtime = runtimeForQueryClient(queryClient);
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

  const unsub = (runtime?.onEvent ?? onEvent)((name: string, raw: unknown) => {
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
    const envelope = raw as DecodedWireEventEnvelope;
    if (envelope.event.type === "turn.ended" && envelope.seq !== cursor.last(sessionId)) {
      notifyCloudAutosaveFailure(envelope.event);
    }
    routeEnvelope(ctx, envelope);
  });

  const unsubCache = queryClient.getQueryCache().subscribe((event) => {
    const [scope, resource, sessionId] = event.query.queryKey;
    if (event.type === "removed" && scope === "sessions" && resource === "messages") {
      folds.delete(sessionId as string);
      cursor.reset(sessionId as string);
    }
  });

  const clearProjection = () => {
    folds.clear();
    for (const sessionId of cursor.sessions()) cursor.reset(sessionId);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    refetchTimers.forEach((timer) => clearTimeout(timer));
    refetchTimers.clear();
  };
  const unsubState = runtime?.onConnectionChange((connected) => {
    // Keep folds and cursors through an outage: an open part keeps streaming
    // onto its fold, and the cursor flags any gap the outage left. Only a
    // disposed runtime (another host, account or grant) drops them.
    if (!connected) return;
    // Recover cached background transcripts too. A delta-only subscription's
    // new cursor cannot recover turn accounting or parts updated while offline.
    for (const query of queryClient
      .getQueryCache()
      .findAll({ queryKey: ["sessions", "messages"] })) {
      const sessionId = query.queryKey[2];
      if (typeof sessionId === "string" && usesBackend(sessionId)) ctx.requestRefetch(sessionId);
    }
  });
  const unsubDispose = runtime?.onDispose(clearProjection);

  return () => {
    unsub();
    unsubCache();
    unsubState?.();
    unsubDispose?.();
    if (frame !== null) cancelAnimationFrame(frame);
    refetchTimers.forEach((timer) => clearTimeout(timer));
    refetchTimers.clear();
  };
}

export function useAgentEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => subscribeToAgentEvents(queryClient), [queryClient]);
}
