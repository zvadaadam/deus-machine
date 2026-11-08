// apps/web/src/features/session/cloud/directSessionRegistry.ts
// The SEND half of the direct-agnt lane (Path B), the twin of cloudFrameHandler's
// receive half.
//
// A module-level registry maps a deus sessionId to the live channel that submits
// prompts and cancels STRAIGHT to agnt over its session socket. The direct render
// lane (`useCloudDirectSession`) registers one while its socket is mounted; the
// send path (`useSendMessage` / `useStopSession`) looks it up to route a send to
// agnt instead of the desktop `q:` relay — which, in "Mac closed", is not there.
//
// Module state, for the same reason the fold set beside it is: the composer that
// sends is portaled OUTSIDE SessionPanel's tree (FocusModeOverlay), so a registry
// it imports beats prop-threading a socket handle to it — the same
// derive-don't-thread rule as `useIsDirectSession`. Presence in the map means
// "this session is served by the direct lane right now"; the channel's own send
// reports whether the socket is actually open (it throws if not — see
// cloudSessionSocket.send), so a send while connecting rolls the bubble back
// through the mutation's normal onError, never a silent drop.
//
// Wire contract: agnt's `handleClientCommand` (`message.send` → `postMessage`,
// `agent.cancel` → `requestCancel`). The frame mirrors the desktop backend's own
// cloud driver (`services/agent/cloud/driver.ts::startCloudTurn`). Both send the
// turn's harness, model and thinking level — agnt chooses none of them and refuses
// a turn that leaves one out — and no credential: the platform selects the
// signed-in user's default provider account when admitting the turn.

import type { ToolRequestEventData } from "@shared/types/query-protocol";
import { readCloudTurnSelection } from "@shared/cloud-models";
import { queryClient } from "@/shared/api/queryClient";
import type { QueryClient } from "@tanstack/react-query";
import type { ElicitationOutcome, ElicitationQuestion } from "@shared/protocol-types";
import { askableQuestions, cardOutcome, cardQuestions } from "@shared/agent-asks";

/** What the composer chose for this turn — never a credential (agnt resolves that). */
export interface DirectTurnOptions {
  model: string;
  agentHarness: string;
  thinkingLevel: string;
}

export interface DirectSessionChannel {
  /**
   * Submit a prompt as a new turn. Fire-and-forget: the turn's echo and events
   * flow back over the render socket, exactly as a Mac-lane send's q:delta does.
   * Throws synchronously if the socket is not open, so the caller's rollback runs.
   */
  sendMessage(prompt: string, turnId: string, options: DirectTurnOptions): void;
  /** Cancel the session's active turn (omit `turnId` to cancel whatever is live). */
  cancel(turnId?: string): void;
  /** Deliver a raw ClientCommand frame (question answers). Throws if the socket
   *  is not open — the caller keeps the answer for the next socket. */
  sendRaw(frame: Record<string, unknown>): void;
}

const channelsByCache = new WeakMap<QueryClient, Map<string, DirectSessionChannel>>();

/**
 * Register a session's direct channel; returns a disposer. The disposer only
 * clears the entry if it is still THIS channel — a fast panel remount can register
 * the replacement before the old effect's cleanup runs, and clearing blindly would
 * delete the live one.
 */
export function registerDirectSession(
  sessionId: string,
  channel: DirectSessionChannel,
  owner: QueryClient = queryClient
): () => void {
  let channels = channelsByCache.get(owner);
  if (!channels) {
    channels = new Map();
    channelsByCache.set(owner, channels);
  }
  channels.set(sessionId, channel);
  return () => {
    if (channels.get(sessionId) === channel) channels.delete(sessionId);
  };
}

/** The live direct channel for a session, or undefined when the Mac lane owns it. */
export function getDirectSession(
  sessionId: string,
  owner: QueryClient = queryClient
): DirectSessionChannel | undefined {
  return channelsByCache.get(owner)?.get(sessionId);
}

// ---- Wire frames (pure; the agnt ClientCommand shapes) ----

/**
 * The `message.send` client command. `idempotencyKey` is the turn id (as the
 * driver does), so an at-least-once socket redelivery replays the same admission
 * instead of minting a second turn. Provider credentials stay on the platform —
 * admission selects the signed-in account, and execution resolves its credential.
 *
 * Throws when the turn does not name all three of its harness, model and
 * thinking level: agnt would refuse it after the bubble went up, so the send's
 * own rollback runs instead.
 */
export function buildMessageSendFrame(
  prompt: string,
  turnId: string,
  options: DirectTurnOptions
): Record<string, unknown> {
  const read = readCloudTurnSelection({
    harness: options.agentHarness,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
  });
  if (!read.ok) throw new Error(read.message);
  return {
    type: "message.send",
    text: prompt,
    messageId: turnId,
    turnId,
    idempotencyKey: turnId,
    options: {
      harness: read.selection.harness,
      model: read.selection.model,
      thinkingLevel: read.selection.thinkingLevel,
    },
  };
}

/** The `agent.cancel` client command. */
export function buildCancelFrame(turnId?: string): Record<string, unknown> {
  return { type: "agent.cancel", ...(turnId ? { turnId } : {}) };
}

// ---- Question round-trip (pure; agnt's elicitation.requested ↔ elicitation.respond) ----

/** The `tool:request` payload the renderer's RPC handlers consume — the SAME
 *  contract the Mac lane's q:event carries, so the direct lane can't drift. */
export type DirectToolRequest = ToolRequestEventData;

/** Long: the sidecar owns the real deadline; this mirrors the Mac driver's relay. */
const QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * An agnt `elicitation.requested` event in question mode (Claude's
 * AskUserQuestion, Codex's request_user_input) → the same `tool:request` the
 * Mac lane delivers via q:event, so `useAgentRpcHandler` shows the existing
 * overlay without knowing which lane asked. The card's questions come from
 * the shared converter (shared/agent-asks.ts), as on the local lane; the deus
 * session id replaces the wire's provider id, exactly as the fold does. The
 * engine's questions are kept to turn the card's answers into the outcome.
 * Returns null for an event with no request id or nothing to ask.
 */
export function toolRequestFromElicitation(
  frame: Record<string, unknown>,
  deusSessionId: string
): { request: DirectToolRequest; questions: ElicitationQuestion[] } | null {
  if (typeof frame.requestId !== "string" || !frame.requestId) return null;
  if (frame.mode !== "question" || !Array.isArray(frame.questions)) return null;
  const questions = askableQuestions(frame.questions);
  if (questions.length === 0) return null;
  return {
    request: {
      requestId: frame.requestId,
      sessionId: deusSessionId,
      method: "askUserQuestion",
      params: { sessionId: deusSessionId, questions: cardQuestions(questions) },
      timeoutMs: QUESTION_TIMEOUT_MS,
    },
    questions,
  };
}

/**
 * The `elicitation.respond` client command. `result` is what the RPC handler
 * responded with (`{answers}`, one per question); anything else — including an
 * error response — becomes a cancellation, which UNBLOCKS the agent instead of
 * leaving it on the sidecar's timeout. A request Deus has no card for (a form,
 * a URL) is declined, as the local lane does.
 */
export function buildElicitationResponseFrame(
  requestId: string,
  providerSessionId: string,
  questions: readonly ElicitationQuestion[],
  result: unknown
): Record<string, unknown> {
  const outcome: ElicitationOutcome =
    questions.length === 0 ? { action: "decline" } : cardOutcome(questions, result);
  return {
    type: "elicitation.respond",
    data: { sessionId: providerSessionId, requestId, outcome },
  };
}

/**
 * The `permission.response` client command: every tool is allowed as-is —
 * parity with the Mac driver, since the sandbox VM is the isolation boundary
 * and deus has no interactive permission UI.
 */
export type PermissionResponseResult = { behavior: "allow" };

export function buildPermissionResponseFrame(
  requestId: string,
  providerSessionId: string,
  result: PermissionResponseResult
): Record<string, unknown> {
  return { type: "permission.response", data: { requestId, sessionId: providerSessionId, result } };
}
