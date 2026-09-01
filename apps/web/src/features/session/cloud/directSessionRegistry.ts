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
// cloud driver (`services/agent/cloud/driver.ts::startCloudTurn`) with ONE
// deliberate difference: no credential rides the wire. The browser holds no org
// key; agnt's session DO resolves it at dispatch (`resolveTurnCredential`, the
// "phone / Mac-off clients" path), so only the harness + per-turn overrides ship.

/** Per-turn overrides the composer offers — never a credential (agnt resolves that). */
export interface DirectTurnOptions {
  model?: string;
  agentHarness?: string;
  thinkingLevel?: string;
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
}

const channels = new Map<string, DirectSessionChannel>();

/**
 * Register a session's direct channel; returns a disposer. The disposer only
 * clears the entry if it is still THIS channel — a fast panel remount can register
 * the replacement before the old effect's cleanup runs, and clearing blindly would
 * delete the live one.
 */
export function registerDirectSession(
  sessionId: string,
  channel: DirectSessionChannel
): () => void {
  channels.set(sessionId, channel);
  return () => {
    if (channels.get(sessionId) === channel) channels.delete(sessionId);
  };
}

/** The live direct channel for a session, or undefined when the Mac lane owns it. */
export function getDirectSession(sessionId: string): DirectSessionChannel | undefined {
  return channels.get(sessionId);
}

// ---- Wire frames (pure; the agnt ClientCommand shapes) ----

/**
 * The `message.send` client command. `idempotencyKey` is the turn id (as the
 * driver does), so an at-least-once socket redelivery replays the same admission
 * instead of minting a second turn. No `apiKey`/`authKind`/`codexAuthJson` —
 * agnt injects the org credential at dispatch; putting one here would both leak it
 * to the browser and be rejected per-turn for codex.
 */
export function buildMessageSendFrame(
  prompt: string,
  turnId: string,
  options: DirectTurnOptions
): Record<string, unknown> {
  const wsOptions: Record<string, unknown> = {};
  // Always send the harness the turn should run: agnt keys the dispatch-time
  // credential lookup on it, so anything but claude-code (codex-sdk,
  // codex-app-server) would otherwise resolve the CLAUDE credential and run as
  // claude. Explicit beats relying on the wire default; the engine validates it.
  if (options.agentHarness) wsOptions.harness = options.agentHarness;
  if (options.model) wsOptions.model = options.model;
  if (options.thinkingLevel) wsOptions.thinkingLevel = options.thinkingLevel;
  return {
    type: "message.send",
    text: prompt,
    turnId,
    idempotencyKey: turnId,
    ...(Object.keys(wsOptions).length > 0 ? { options: wsOptions } : {}),
  };
}

/** The `agent.cancel` client command. */
export function buildCancelFrame(turnId?: string): Record<string, unknown> {
  return { type: "agent.cancel", ...(turnId ? { turnId } : {}) };
}
