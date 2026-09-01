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
 * The token is provided by the caller (`useCloudDirect`, minted at the backend
 * seam or via the dashboard exchange — `exchangeSessionToken.ts`). Where the
 * browser gets its `deus_cloud_session` to mint that token is a separate,
 * upstream concern.
 *
 * LANE GATING — the direct lane writes the SAME cache key `useMessages` owns
 * (`queryKeys.sessions.messages(sessionId)`), so exactly one lane may drive it.
 * `useMessages` gates its HTTP `queryFn`, its `messages` WS subscription, and its
 * reconnect-invalidate on `direct === false` (derived via `useIsDirectSession`),
 * so a cloud-direct session's Mac lanes all stand down and this fold owns the key.
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
import {
  registerDirectSession,
  buildMessageSendFrame,
  buildCancelFrame,
} from "../cloud/directSessionRegistry";

/** A burst of gaps must not become a burst of full-page refetches. */
const REFETCH_DEBOUNCE_MS = 250;

/**
 * The direct-agnt lane's own fold set — module state, separate from the Mac
 * lane's in `useAgentEvents`, because the stream outlives the panel. Unlike the
 * Mac lane it keeps no cursor: agnt frames carry no seq, so `makeCloudFrameHandler`
 * folds straight through (see its header); the throwaway `cursor` below only
 * satisfies the shared `AgentStreamContext` type, which the Mac lane needs.
 */
const folds = new Map<string, SessionFold>();
const cursor = createStreamCursor();

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

    const foldFrame = makeCloudFrameHandler(ctx, sessionId);

    const onFrame = (frame: Record<string, unknown>) => {
      // A rejected client command (agnt's `{type:"error"}` channel frame, e.g.
      // MESSAGE_SEND_FAILED) — the send was fire-and-forget, so this frame is
      // the only rollback signal. Surface it; the socket itself is still fine.
      if (frame.type === "error") {
        const message = typeof frame.message === "string" ? frame.message : "Command failed";
        setError(typeof frame.code === "string" ? `${frame.code}: ${message}` : message);
        return;
      }
      // A fatal agent error is its OWN ws event (`session.error`), not a fold
      // lifecycle event — surface it so a failed session doesn't look idle.
      // agnt's shape is `{error: {code, message}, recoverable?}`; older/other
      // producers may send a plain string, so read both.
      if (frame.type === "session.error") {
        const nested = frame.error as { code?: unknown; message?: unknown } | string | undefined;
        const message =
          typeof nested === "string"
            ? nested
            : typeof nested?.message === "string"
              ? nested.message
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

    // Expose the SEND half: while this socket is mounted, sends and cancels for
    // this session go straight to agnt (the Mac `q:` relay is closed). The frame
    // builders are the agnt ClientCommand wire; `socket.send` throws if the socket
    // is not open yet, which surfaces as the send mutation's normal rollback.
    const disposeChannel = registerDirectSession(sessionId, {
      sendMessage: (prompt, turnId, options) => {
        // Enforce deus's one-live-turn contract here, where the fold state is in
        // reach — agnt itself QUEUES overlapping sends, so without this a
        // double-send starts a second turn (parity with the Mac driver's
        // `liveTurnId` guard). The throw rolls the optimistic bubble back.
        if (folds.get(sessionId)?.state.turns.some((turn) => turn.status === "active")) {
          throw new Error("The agent is still working — wait for the current turn to finish.");
        }
        socket.send(buildMessageSendFrame(prompt, turnId, options));
      },
      cancel: (turnId) => socket.send(buildCancelFrame(turnId)),
    });

    return () => {
      disposeChannel();
      socket.close();
      if (frame !== null) cancelAnimationFrame(frame);
      refetchTimers.forEach((timer) => clearTimeout(timer));
      refetchTimers.clear();
    };
  }, [sessionId, providerSessionId, baseUrl, token, queryClient]);

  return { status, error };
}
