/**
 * useCloudDirectSession — render a cloud session by connecting DIRECTLY to agnt.
 *
 * Path B, slice 2. The Mac-backed path folds the `q:` `agent:event` stream
 * (`useAgentEvents`); this is its twin for "Mac closed": it opens the agnt
 * session socket in the browser and drives the SAME fold into the SAME cache key
 * (`queryKeys.sessions.messages(sessionId)`), so `SessionPanel`/`useMessages`
 * render it with no UI change. The `q:` singleton is untouched — this is a
 * parallel lane.
 *
 * A cloud session is rendered by EITHER lane, never both: use this hook instead
 * of `useAgentEvents` when the session is served direct. So it keeps its own
 * `folds`/`cursor` module state, isolated from the Mac lane's.
 *
 * The token is provided by the caller (minted via the dashboard exchange —
 * `exchangeSessionToken.ts`). Where the browser gets its `deus_cloud_session` to
 * mint that token is a separate, upstream concern.
 *
 * INTEGRATION GATE — this hook has no callers yet. The direct lane writes the
 * SAME cache key `useMessages` owns (`queryKeys.sessions.messages(sessionId)`).
 * Whoever wires it in MUST disable `useMessages`' own HTTP `queryFn` and its
 * `messages` WS subscription for a cloud-direct session — otherwise that fetch
 * (which resolves authoritative-EMPTY in Mac-closed mode) will clobber the
 * folded transcript. Gate the lanes so exactly one drives that key.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createStreamCursor,
  flushDeltas,
  pruneFolds,
  refetchMessages,
  type AgentStreamContext,
  type SessionFold,
} from "../lib/agentEventFold";
import { connectCloudSessionSocket } from "../cloud/cloudSessionSocket";
import { makeCloudFrameHandler } from "../cloud/cloudFrameHandler";

/** A burst of gaps must not become a burst of full-page refetches. */
const REFETCH_DEBOUNCE_MS = 250;

/**
 * The direct-agnt lane's own fold set + cursor — module state, separate from the
 * Mac lane's in `useAgentEvents`, for the same reasons documented there (the
 * stream outlives the panel; the cursor makes a real gap visible).
 */
const folds = new Map<string, SessionFold>();
const cursor = createStreamCursor();
/**
 * A PERSISTENT per-session synthetic seq, lifetime-matched to `cursor` above.
 * A remount builds a fresh handler but must keep counting from where the last
 * left off, or the next snapshot's first envelope (seq 1) reads as a fresh log
 * to a cursor already past it — a spurious reset + refetch every remount.
 */
const seqCounters = new Map<string, number>();

export interface CloudDirectSessionParams {
  /** deus session id — the fold/cache key everywhere the UI reads. */
  sessionId: string;
  /** agnt session id — what the socket connects to. */
  providerSessionId: string;
  /** agnt backend origin (http/https or ws/wss). */
  baseUrl: string;
  /** Session-scoped JWT from the dashboard exchange. */
  token: string;
}

export type CloudDirectStatus = "idle" | "connecting" | "open" | "down" | "error";

export interface CloudDirectSessionState {
  status: CloudDirectStatus;
  error: string | null;
}

export function useCloudDirectSession(
  params: CloudDirectSessionParams | null
): CloudDirectSessionState {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CloudDirectStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const sessionId = params?.sessionId ?? null;
  const providerSessionId = params?.providerSessionId ?? null;
  const baseUrl = params?.baseUrl ?? null;
  const token = params?.token ?? null;

  useEffect(() => {
    if (!sessionId || !providerSessionId || !baseUrl || !token) {
      setStatus("idle");
      return;
    }

    pruneFolds(queryClient, folds);
    setStatus("connecting");
    setError(null);

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

    const nextSeq = () => {
      const n = (seqCounters.get(sessionId) ?? 0) + 1;
      seqCounters.set(sessionId, n);
      return n;
    };
    const foldFrame = makeCloudFrameHandler(ctx, sessionId, nextSeq);

    const onFrame = (frame: Record<string, unknown>) => {
      // A fatal agent error is its OWN ws event (`session.error`), not a fold
      // lifecycle event — surface it so a failed session doesn't look idle.
      if (frame.type === "session.error") {
        const message =
          typeof frame.error === "string"
            ? frame.error
            : typeof frame.message === "string"
              ? frame.message
              : "Session error";
        setStatus("error");
        setError(message);
        return;
      }
      foldFrame(frame);
    };

    const socket = connectCloudSessionSocket({
      baseUrl,
      providerSessionId,
      token,
      onFrame,
      onOpen: () => setStatus("open"),
      onDown: (reason) => {
        setStatus("down");
        setError(reason);
      },
    });

    return () => {
      socket.close();
      if (frame !== null) cancelAnimationFrame(frame);
      refetchTimers.forEach((timer) => clearTimeout(timer));
      refetchTimers.clear();
    };
  }, [sessionId, providerSessionId, baseUrl, token, queryClient]);

  return { status, error };
}
