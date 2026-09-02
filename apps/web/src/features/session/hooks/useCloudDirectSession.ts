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
  patchSessionDetail,
  pruneFolds,
  refetchMessages,
  type AgentStreamContext,
  type SessionFold,
} from "../lib/agentEventFold";
import { connectCloudSessionSocket } from "../cloud/cloudSessionSocket";
import { makeCloudFrameHandler } from "../cloud/cloudFrameHandler";
import { dropOptimisticMessage } from "../lib/optimisticMessage";
import { match } from "ts-pattern";
import type { ToolRequestEventData } from "@shared/types/query-protocol";
import {
  registerDirectSession,
  getDirectSession,
  buildMessageSendFrame,
  buildCancelFrame,
  buildMcpAnswerFrame,
  buildPermissionResponseFrame,
  askUserQuestionPermissionResult,
  toolRequestFromMcpQuestion,
} from "../cloud/directSessionRegistry";
import { questionsFromAskUserQuestionInput } from "@shared/ask-user-question";
import { emitLocalEvent, setToolResponseInterceptor, TOOL_CANCEL_EVENT } from "@/platform/ws";
import type { QueryClient } from "@tanstack/react-query";

// ---- Question round-trip ----------------------------------------------------
// The agent's questions reach the browser as frames on the direct socket: the
// sidecar's MCP question tool as `mcp.question`, Claude Code's built-in
// AskUserQuestion as a `permission.request` (its answers ride back in
// `updatedInput`). The Mac lane relays these to the renderer as a `tool:request`
// q:event and answers over its own socket; here the renderer IS the client, so
// each frame is handed to the same handlers locally and the answer goes back on
// whichever socket serves the session WHEN the user answers — a remount, a
// reconnect or a brief outage must not lose the correlation. One registry per
// renderer, keyed by the LOCAL request id the overlay sees; `sendToolResponse`
// consults it before the (dark) q: lane.
type PendingQuestionKind =
  | { kind: "mcp" }
  | {
      kind: "permission";
      /** Echoed back with the answers folded in (the tool's own contract). */
      input: unknown;
    };
interface PendingDirectQuestion {
  /** The id agnt correlates on (questionId / permission requestId). */
  wireRequestId: string;
  sessionId: string;
  providerSessionId: string;
  queryClient: QueryClient;
  ask: PendingQuestionKind;
  /** The turn that was live when the question arrived (the wire carries no
   *  turn id; the fold's active turn is the binding). A reconnect snapshot
   *  re-presents the question only for THAT turn — undefined (no admitted
   *  turn in the fold yet) falls back to "any live turn". */
  turnId?: string;
  /** What the overlay was shown — re-emitted verbatim after a remount. */
  request: Omit<ToolRequestEventData, "requestId">;
}
const pendingDirectQuestions = new Map<string, PendingDirectQuestion>();
let localRequestCounter = 0;

/** Show (or re-show) a parked question: a fresh local id each time, because
 *  the RPC handler dedupes ids it has already answered. */
function presentDirectQuestion(pending: PendingDirectQuestion): void {
  const localId = `${pending.wireRequestId}#${++localRequestCounter}`;
  pendingDirectQuestions.set(localId, pending);
  emitLocalEvent("tool:request", { ...pending.request, requestId: localId });
}

function parkDirectQuestion(pending: PendingDirectQuestion): void {
  patchSessionDetail(pending.queryClient, pending.sessionId, { status: "needs_response" });
  presentDirectQuestion(pending);
}

/** The fold's active turn — what a freshly arrived question belongs to. */
function activeTurnId(sessionId: string): string | undefined {
  return folds.get(sessionId)?.state.turns.find((turn) => turn.status === "active")?.turnId;
}

/** Retract a presented question: the registry forgets it AND the overlay
 *  drops it (a card the agent no longer accepts must not stay answerable). */
function retractDirectQuestion(localId: string, pending: PendingDirectQuestion): void {
  pendingDirectQuestions.delete(localId);
  emitLocalEvent(TOOL_CANCEL_EVENT, { sessionId: pending.sessionId, requestId: localId });
}

/** Drop every parked question of a session (its turn ended — a late answer
 *  must not revive it) without answering. */
function dropDirectQuestions(sessionId: string): void {
  for (const [id, pending] of [...pendingDirectQuestions]) {
    if (pending.sessionId === sessionId) retractDirectQuestion(id, pending);
  }
}

setToolResponseInterceptor((requestId, result, error) => {
  const pending = pendingDirectQuestions.get(requestId);
  if (!pending) return false;
  pendingDirectQuestions.delete(requestId);
  const answers =
    error === undefined && result && typeof result === "object"
      ? (result as { answers?: unknown }).answers
      : undefined;
  const frame = match(pending.ask)
    .with({ kind: "permission" }, ({ input }) =>
      // Built-in AskUserQuestion: the answers fold into the tool's input; a
      // dismissal (empty, or the overlay's sentinel) is an honest deny.
      buildPermissionResponseFrame(
        pending.wireRequestId,
        pending.providerSessionId,
        askUserQuestionPermissionResult(input, answers)
      )
    )
    .with({ kind: "mcp" }, () =>
      // An error response still UNBLOCKS the agent (schema-valid cancellation).
      buildMcpAnswerFrame(
        pending.wireRequestId,
        pending.providerSessionId,
        error === undefined ? result : undefined
      )
    )
    .exhaustive();
  // Whichever socket serves the session NOW — the one the question arrived on
  // may be gone. If none is open, keep the answer's question parked and put
  // the overlay back so the user can answer once the lane is up again.
  try {
    const channel = getDirectSession(pending.sessionId);
    if (!channel) throw new Error("no direct channel");
    channel.sendRaw(frame);
  } catch {
    presentDirectQuestion(pending);
    return true;
  }
  // Only a still-live turn goes back to "working": a stale overlay answered
  // after the turn ended (or was stopped) must not revive a finished session.
  if (folds.get(pending.sessionId)?.state.turns.some((turn) => turn.status === "active")) {
    patchSessionDetail(pending.queryClient, pending.sessionId, { status: "working" });
  }
  return true;
});

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

    // The turn SENT on this socket that agnt hasn't ADMITTED yet (no
    // `turn.started` echo). The fold only learns a turn exists when the echo
    // returns, so a double-Enter inside that round-trip would pass the fold's
    // guard and agnt would QUEUE the second prompt. Tracked synchronously at
    // send; cleared on admission, rejection, or a socket boundary (a reconnect
    // re-syncs the truth from the snapshot). The staleness window is a
    // self-heal for a frame that gets neither echo nor error.
    let pendingTurn: { turnId: string; at: number } | null = null;
    const PENDING_TURN_STALE_MS = 30_000;
    const pendingTurnActive = () =>
      pendingTurn !== null && Date.now() - pendingTurn.at < PENDING_TURN_STALE_MS;

    const onFrame = (frame: Record<string, unknown>) => {
      // The agent asked the user something: park it for the overlay (the same
      // `tool:request` the Mac lane delivers) and mark the row as waiting so
      // the sidebar shows attention, not a spinner. Answered via the
      // interceptor above; the sidecar's own timeout is the fallback.
      if (frame.type === "mcp.question") {
        const request = toolRequestFromMcpQuestion(frame, sessionId);
        if (request) {
          const { requestId: wireRequestId, ...rest } = request;
          parkDirectQuestion({
            wireRequestId,
            sessionId,
            providerSessionId,
            queryClient,
            turnId: activeTurnId(sessionId),
            ask: { kind: "mcp" },
            request: rest,
          });
        }
        return;
      }
      // The permission bridge: the sidecar forwards EVERY SDK approval request.
      // Claude Code's built-in AskUserQuestion is one of them — its questions
      // ride `input`, its answers ride back in `updatedInput` — and it is the
      // question tool the model actually reaches for. Everything else is
      // allowed on the spot (the sandbox is the isolation boundary; parity
      // with the Mac driver), or the agent would park on the sidecar's timeout.
      if (frame.type === "permission.request") {
        const data = (frame.data ?? {}) as {
          requestId?: unknown;
          toolName?: unknown;
          input?: unknown;
        };
        if (typeof data.requestId !== "string" || !data.requestId) return;
        const questions =
          data.toolName === "AskUserQuestion" ? questionsFromAskUserQuestionInput(data.input) : [];
        if (questions.length === 0) {
          socket.send(
            buildPermissionResponseFrame(data.requestId, providerSessionId, { behavior: "allow" })
          );
          return;
        }
        parkDirectQuestion({
          wireRequestId: data.requestId,
          sessionId,
          providerSessionId,
          queryClient,
          turnId: activeTurnId(sessionId),
          ask: { kind: "permission", input: data.input },
          request: {
            sessionId,
            method: "askUserQuestion",
            params: { sessionId, questions },
            timeoutMs: 24 * 60 * 60 * 1000,
          },
        });
        return;
      }
      // The (re)connect snapshot is the truth about a parked question's turn.
      // Live turn: put the overlay back — the frame that asked is consumed
      // (the snapshot won't replay it) and the agent is still waiting on the
      // sidecar's clock. No live turn: it ended while this socket was down
      // (stopped from another client, timed out) and the agent no longer
      // accepts the answer — drop it, or a stale card lives across remounts.
      // A question bound to a turn other than the live one (turn A ended and
      // turn B started while disconnected) is stale too: its answer would
      // carry A's request id to an agent already past it.
      if (frame.type === "session.snapshot") {
        const state = frame.state as { currentTurnId?: unknown } | undefined;
        const live =
          typeof state?.currentTurnId === "string" && state.currentTurnId
            ? state.currentTurnId
            : null;
        for (const [id, pending] of [...pendingDirectQuestions]) {
          if (pending.sessionId !== sessionId) continue;
          if (live && (pending.turnId === undefined || pending.turnId === live)) {
            pendingDirectQuestions.delete(id);
            presentDirectQuestion(pending);
          } else {
            retractDirectQuestion(id, pending);
          }
        }
      }
      // A fresh turn proves the lane works — clear any earlier surfaced error
      // (SessionPanel derives an "error" status from it, which must not outlive
      // the failure it reported) and the pending-admission marker.
      if (frame.type === "turn.started") {
        setError(null);
        pendingTurn = null;
      }
      // The turn is over (finished or stopped): any question still parked for
      // it can no longer be answered meaningfully — drop it so a stale overlay
      // can't flip the finished session back to "working".
      if (frame.type === "turn.ended") dropDirectQuestions(sessionId);
      // A rejected client command (agnt's `{type:"error"}` channel frame, e.g.
      // MESSAGE_SEND_FAILED) — the send was fire-and-forget, so this frame is
      // the only rollback signal: surface it AND drop the optimistic bubble of
      // the pending turn (the frame carries no turnId; one-live-turn means the
      // pending send is the only candidate). The socket itself is still fine.
      // CATEGORY-bearing error frames are the ENGINE's error events, not command
      // rejections — they fall through to the fold (which records them on the
      // turn), exactly as the Mac driver splits them.
      if (frame.type === "error" && typeof frame.category !== "string") {
        if (pendingTurn) {
          dropOptimisticMessage(queryClient, sessionId, pendingTurn.turnId);
          pendingTurn = null;
        }
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
      onOpen: () => {
        // A (re)connect re-syncs turn truth from the snapshot — a pre-drop
        // pending marker must not block the first post-reconnect send.
        // Parked questions wait for that snapshot too (see onFrame).
        pendingTurn = null;
        setStatus("open");
      },
      onDown: (reason) => {
        pendingTurn = null;
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
        // `liveTurnId` guard). The fold covers ADMITTED turns; `pendingTurn`
        // covers the echo round-trip a double-Enter fits inside. The throw
        // rolls the optimistic bubble back.
        if (
          pendingTurnActive() ||
          folds.get(sessionId)?.state.turns.some((turn) => turn.status === "active")
        ) {
          throw new Error("The agent is still working — wait for the current turn to finish.");
        }
        socket.send(buildMessageSendFrame(prompt, turnId, options));
        pendingTurn = { turnId, at: Date.now() };
      },
      cancel: (turnId) => socket.send(buildCancelFrame(turnId)),
      sendRaw: (raw) => socket.send(raw),
    });

    return () => {
      disposeChannel();
      socket.close();
      // Parked questions deliberately SURVIVE this teardown: the next socket
      // for the session re-presents them off its snapshot (or drops them if
      // the turn is gone), and the answer resolves the channel at send time.
      // The sidecar's timeout is the only other exit.
      if (frame !== null) cancelAnimationFrame(frame);
      refetchTimers.forEach((timer) => clearTimeout(timer));
      refetchTimers.clear();
    };
  }, [sessionId, providerSessionId, baseUrl, token, queryClient]);

  return { status, error };
}
