/**
 * useAgentEvents — subscribe to the canonical agent stream and fold it.
 *
 * The backend forwards every @zvada/agent-server lifecycle envelope verbatim
 * as ONE q:event (`agent:event`). This hook owns only the browser-shaped parts
 * of consuming it — the socket subscription, the animation-frame delta flush
 * and the debounced refetch. The fold itself lives in `lib/agentEventFold`, so
 * it can be tested without React, a DOM or a socket.
 *
 * The subscription is global (one socket, all sessions), and so is the fold:
 * envelopes for OTHER sessions still patch their cached pages, because a
 * `turn.ended` is an UPDATE — tokens, cost, turn_stop_reason, cancelled_at —
 * and the delta-only `messages` subscription can only carry INSERTs. Without
 * that, starting a turn and switching tabs left the footer permanently blank.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onEvent } from "@/platform/ws";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import {
  createStreamCursor,
  flushDeltas,
  messagesKey,
  routeEnvelope,
  type AgentStreamContext,
  type SessionFold,
} from "../lib/agentEventFold";

/** A burst of gaps must not become a burst of full-page refetches. */
const REFETCH_DEBOUNCE_MS = 250;

export function useAgentEvents(sessionId: string | null): void {
  const queryClient = useQueryClient();
  const foldsRef = useRef(new Map<string, SessionFold>());
  const cursorRef = useRef(createStreamCursor());

  useEffect(() => {
    if (!sessionId) return;

    const folds = foldsRef.current;
    const cursor = cursorRef.current;
    let frame: number | null = null;
    const refetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const ctx: AgentStreamContext = {
      queryClient,
      activeSessionId: sessionId,
      folds,
      cursor,
      scheduleFlush: () => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          const fold = folds.get(sessionId);
          if (fold) flushDeltas(queryClient, sessionId, fold);
        });
      },
      requestRefetch: (target) => {
        clearTimeout(refetchTimers.get(target));
        refetchTimers.set(
          target,
          setTimeout(() => {
            refetchTimers.delete(target);
            void queryClient.refetchQueries({ queryKey: messagesKey(target), exact: true });
          }, REFETCH_DEBOUNCE_MS)
        );
      },
    };

    const unsub = onEvent((name: string, raw: unknown) => {
      if (name !== "agent:event") return;
      routeEnvelope(ctx, raw as DecodedWireEventEnvelope);
    });

    return () => {
      unsub();
      if (frame !== null) cancelAnimationFrame(frame);
      refetchTimers.forEach((timer) => clearTimeout(timer));
      refetchTimers.clear();
      // The folded conversations and their cursors go with the subscription:
      // a remount re-reads the durable page from SQLite and joins the live
      // stream wherever it now is, so keeping a half-folded state (or a
      // watermark from the old subscription) would only make the first
      // envelope after the remount look like a gap.
      folds.clear();
      cursor.sessions().forEach((id) => cursor.reset(id));
    };
  }, [sessionId, queryClient]);
}
