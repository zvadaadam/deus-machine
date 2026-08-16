/**
 * useAgentEvents — subscribe to the canonical agent stream and fold it.
 *
 * The backend forwards every @zvada/agent-server lifecycle envelope verbatim
 * as ONE q:event (`agent:event`). This hook owns only the browser-shaped parts
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
import { useQueryClient } from "@tanstack/react-query";
import { onEvent } from "@/platform/ws";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import {
  createStreamCursor,
  flushDeltas,
  pruneFolds,
  refetchMessages,
  routeEnvelope,
  type AgentStreamContext,
  type SessionFold,
} from "../lib/agentEventFold";

/** A burst of gaps must not become a burst of full-page refetches. */
const REFETCH_DEBOUNCE_MS = 250;

/**
 * One fold set and one cursor for the window — module state, NOT `useRef`.
 *
 * The only caller is `SessionPanel`, and it is rendered `key={sessionId}`: a
 * tab switch unmounts the whole panel, so anything a ref held died with it and
 * the next panel folded the stream against nothing. A `turn.ended(cancelled)`
 * then found no open tool part to close, that part write is an UPDATE so it
 * could not ride the insert-only `messages` delta either, and the cached page —
 * fresh forever under `staleTime: Infinity` — kept a finished tool spinning
 * until something else forced a reload. The stream is the socket's, not the
 * panel's, so its bookkeeping outlives the panel.
 *
 * Keeping the CURSOR is what makes a real hole visible: while no panel is
 * mounted nothing is subscribed, and a fresh cursor re-seeks to whatever
 * envelope it sees first and swallows the gap silently. A kept one reports it,
 * and `routeEnvelope` refetches. State that has genuinely died is dropped where
 * it is detectable — `routeEnvelope` deletes the fold on a replaced session log
 * — and the rest is bounded by `pruneFolds`, which cannot let the fold set
 * outgrow the message cache it projects into.
 *
 * At most one panel is mounted at a time (ChatArea renders one, and the mobile
 * layout is the other branch of the same ternary), so there is no second
 * subscription to race this one to the cursor.
 */
const folds = new Map<string, SessionFold>();
const cursor = createStreamCursor();

export function useAgentEvents(sessionId: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sessionId) return;

    pruneFolds(queryClient, folds);
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
            void refetchMessages(queryClient, target);
          }, REFETCH_DEBOUNCE_MS)
        );
      },
    };

    const unsub = onEvent((name: string, raw: unknown) => {
      if (name !== "agent:event") return;
      routeEnvelope(ctx, raw as DecodedWireEventEnvelope);
    });

    // Only what this SUBSCRIPTION owns is torn down: the pending frame and the
    // pending refetch timers, both of which close over the ctx going away.
    return () => {
      unsub();
      if (frame !== null) cancelAnimationFrame(frame);
      refetchTimers.forEach((timer) => clearTimeout(timer));
      refetchTimers.clear();
    };
  }, [sessionId, queryClient]);
}
