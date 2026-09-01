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

// ---- Question round-trip (pure; the agnt mcp.question ↔ mcp.answer wire) ----

/** The `tool:request` payload the renderer's RPC handlers consume (mirrors
 *  `ToolRequestEventData` in shared/types/query-protocol). */
export interface DirectToolRequest {
  requestId: string;
  sessionId: string;
  method: "askUserQuestion";
  params: { sessionId: string; questions: Array<Record<string, unknown>> };
  timeoutMs: number;
}

/** Long: the sidecar owns the real deadline; this mirrors the Mac driver's relay. */
const QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * An agnt `mcp.question` frame (the agent's AskUserQuestion) → the same
 * `tool:request` the Mac lane delivers via q:event, so `useAgentRpcHandler`
 * shows the existing overlay without knowing which lane asked. agnt's items
 * are `{text, options?, allowsMultiSelect?}`; the handler's tolerant reader
 * wants `{question, options, multiSelect}`. The deus session id replaces the
 * wire's provider id, exactly as the fold does. Returns null for a frame with
 * no usable question id.
 */
export function toolRequestFromMcpQuestion(
  frame: Record<string, unknown>,
  deusSessionId: string
): DirectToolRequest | null {
  const data = (frame.data ?? {}) as {
    questionId?: unknown;
    questions?: unknown;
  };
  if (typeof data.questionId !== "string" || !data.questionId) return null;
  const items = Array.isArray(data.questions) ? data.questions : [];
  const questions = items.flatMap((item): Array<Record<string, unknown>> => {
    if (!item || typeof item !== "object") return [];
    const q = item as { text?: unknown; options?: unknown; allowsMultiSelect?: unknown };
    if (typeof q.text !== "string" || !q.text.trim()) return [];
    return [
      {
        question: q.text,
        options: Array.isArray(q.options) ? q.options.filter((o) => typeof o === "string") : [],
        ...(typeof q.allowsMultiSelect === "boolean" ? { multiSelect: q.allowsMultiSelect } : {}),
      },
    ];
  });
  return {
    requestId: data.questionId,
    sessionId: deusSessionId,
    method: "askUserQuestion",
    params: { sessionId: deusSessionId, questions },
    timeoutMs: QUESTION_TIMEOUT_MS,
  };
}

/**
 * The `mcp.answer` client command for a handled question. `result` is what the
 * RPC handler responded with (`{answers: string[]}`); anything else — including
 * an error response — becomes the schema-valid cancellation, which UNBLOCKS the
 * agent instead of leaving it on the sidecar's timeout.
 */
export function buildMcpAnswerFrame(
  questionId: string,
  providerSessionId: string,
  result: unknown
): Record<string, unknown> {
  const maybe =
    result && typeof result === "object" ? (result as { answers?: unknown }).answers : undefined;
  const answers = Array.isArray(maybe) && maybe.length > 0 ? maybe.map(String) : ["USER_CANCELLED"];
  return { type: "mcp.answer", data: { questionId, sessionId: providerSessionId, answers } };
}

/**
 * The `permission.response` client command. AskUserQuestion answers ride
 * `result.updatedInput` (see shared/ask-user-question); every other tool is
 * allowed as-is — parity with the Mac driver, since the sandbox VM is the
 * isolation boundary and deus has no interactive permission UI.
 */
export function buildPermissionResponseFrame(
  requestId: string,
  providerSessionId: string,
  result:
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string }
): Record<string, unknown> {
  return { type: "permission.response", data: { requestId, sessionId: providerSessionId, result } };
}
