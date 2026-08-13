// backend/src/services/agent/translate/translator.ts
// Translate the standard wire's LifecycleEvent stream into deus AgentEvents
// feeding the existing event handler (persistence + WS push). This is the
// backend-side successor of the agent-server's CoreEventBridge: native-session
// capture, the live context gauge with its sticky merge, error surfacing
// (deduped per turn), the PartEvent translation, and the terminal session
// status. DESIGN.md upstream calls this layer the per-consumer migration shim
// — it dies when the frontend consumes engine vocabulary natively.

import type { LifecycleEvent, WireEventEnvelope } from "@zvada/agent-server/protocol";
import type { AgentEvent, PartEvent } from "@shared/agent-events";
import type { AgentHarness, ErrorCategory } from "@shared/enums";
import { classifyError, classifyStopReason } from "./classify";
import { LifecycleToPartEvents } from "./lifecycle-shim";

/** Engine error categories → deus error categories (rest fold into internal). */
const ERROR_CATEGORY: Record<string, ErrorCategory> = {
  auth: "auth",
  rate_limit: "rate_limit",
  usage_limit: "rate_limit",
  context_limit: "context_limit",
  network: "network",
  abort: "abort",
  process_exit: "process_exit",
};

interface TranslatorSession {
  harness: AgentHarness;
  /** The active turn — cleared once its turn.ended has been translated. */
  turnId?: string;
  /** Per-turn stateful part translator. */
  shim: LifecycleToPartEvents;
  /** One session.error per turn (turn.ended(error) must not double-report). */
  errorReported: boolean;
  /** Merged context gauge — Claude reports `size`/`cost` only on the final
   *  result; a later used-only event must not erase them. */
  lastUsage?: { used: number; size?: number; cost?: number };
}

export interface LifecycleTranslatorDeps {
  emit: (event: AgentEvent) => void;
  /** Fallback harness lookup (DB) for events arriving without a beginTurn —
   *  e.g. replayed events after a backend restart. */
  resolveHarness?: (sessionId: string) => AgentHarness | undefined;
}

export class LifecycleTranslator {
  private readonly sessions = new Map<string, TranslatorSession>();

  constructor(private readonly deps: LifecycleTranslatorDeps) {}

  /**
   * Register a turn ahead of its quick-ack round-trip: resets the per-turn
   * state and emits the deus session.started (status → working), mirroring
   * the legacy server's accept path.
   *
   * Returns false — touching NOTHING — when the session already has an
   * active turn: a concurrent send is about to be rejected with turnActive,
   * and replacing the live turn's shim would corrupt its part bookkeeping.
   * Callers re-register with `force` if the server accepts anyway (stale
   * local state, e.g. after a backend restart).
   */
  beginTurn(
    sessionId: string,
    harness: AgentHarness,
    turnId: string,
    opts: { force?: boolean } = {}
  ): boolean {
    const existing = this.sessions.get(sessionId);
    if (existing?.turnId !== undefined && !opts.force) return false;
    this.sessions.set(sessionId, {
      harness,
      turnId,
      shim: new LifecycleToPartEvents(),
      errorReported: false,
      lastUsage: existing?.lastUsage,
    });
    this.deps.emit({ type: "session.started", sessionId, agentHarness: harness });
    return true;
  }

  /** Roll back a beginTurn whose start was rejected (only if still ours). */
  abortTurn(sessionId: string, turnId: string): void {
    const state = this.sessions.get(sessionId);
    if (state?.turnId === turnId) state.turnId = undefined;
  }

  /** Feed one sequenced wire envelope (post-dedupe, in order). */
  handle(envelope: WireEventEnvelope): void {
    const event = envelope.event;
    // The envelope always carries the session id (some event members, e.g.
    // `error`, mark it optional in the event body).
    const sessionId = envelope.sessionId;
    const state = this.stateFor(sessionId);
    if (!state) {
      console.warn(
        `[translator] Dropping ${event.type} for unknown session ${sessionId} (no harness)`
      );
      return;
    }

    switch (event.type) {
      case "session.created":
        this.deps.emit({
          type: "agent.session_id",
          sessionId,
          agentSessionId: event.nativeSessionId,
        });
        return;
      case "session.usage":
        state.lastUsage = {
          used: event.used,
          size: event.size ?? state.lastUsage?.size,
          cost: event.cost ?? state.lastUsage?.cost,
        };
        // Live context gauge: persisted onto the session row
        // (context_token_count / context_used_percent) for the composer UI.
        // Emit the MERGED values — a used-only update with a raw undefined
        // size would desync the persisted count from the stale percent.
        this.deps.emit({
          type: "session.contextUsage",
          sessionId,
          agentHarness: state.harness,
          used: event.used,
          ...(state.lastUsage.size !== undefined ? { size: state.lastUsage.size } : {}),
          ...(state.lastUsage.cost !== undefined ? { cost: state.lastUsage.cost } : {}),
        });
        return;
      case "error":
        // Recoverable errors (the engine is retrying / the turn continues) are
        // diagnostics, not terminal state — promoting them would flip the UI to
        // an error while the agent is still running AND suppress the real
        // terminal error via the dedupe flag.
        if (event.recoverable) return;
        state.errorReported = true;
        this.deps.emit({
          type: "session.error",
          sessionId,
          agentHarness: state.harness,
          error: event.error,
          category: ERROR_CATEGORY[event.code ?? ""] ?? "internal",
        });
        return;
      case "session.compacted":
      case "permission.requested":
      case "permission.resolved":
      case "raw":
        // No deus counterpart (yet) — compaction awaits its persisted marker,
        // permissions are decided in-process by the tool policy.
        return;
      default:
    }

    this.emitParts(sessionId, state, event);
    if (event.type === "turn.ended") this.emitTerminalStatus(sessionId, state, event);
  }

  private stateFor(sessionId: string): TranslatorSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const harness = this.deps.resolveHarness?.(sessionId);
    if (!harness) return undefined;
    const state: TranslatorSession = {
      harness,
      shim: new LifecycleToPartEvents(),
      errorReported: false,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private emitParts(sessionId: string, state: TranslatorSession, event: LifecycleEvent): void {
    const turnId = ("turnId" in event ? event.turnId : undefined) ?? state.turnId ?? "";
    for (const partEvent of state.shim.translate(event)) {
      this.emitPartEvent(sessionId, state.harness, turnId, partEvent);
    }
  }

  /** Deus AgentEvent framing for one PartEvent (ex-EventBroadcaster.emitPartEvent). */
  private emitPartEvent(
    sessionId: string,
    agentHarness: AgentHarness,
    messageId: string,
    event: PartEvent
  ): void {
    switch (event.type) {
      case "turn.started":
        this.deps.emit({
          type: "turn.started",
          sessionId,
          agentHarness,
          messageId,
          turnId: event.turnId,
        });
        break;
      case "message.created":
        this.deps.emit({
          type: "message.created",
          sessionId,
          agentHarness,
          messageId: event.messageId,
          role: event.role,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        });
        break;
      case "part.created":
        this.deps.emit({
          type: "part.created",
          sessionId,
          agentHarness,
          messageId: event.part.messageId,
          partId: event.part.id,
          part: event.part,
        });
        break;
      case "part.delta":
        this.deps.emit({
          type: "part.delta",
          sessionId,
          agentHarness,
          partId: event.partId,
          delta: event.delta,
        });
        break;
      case "part.done":
        this.deps.emit({
          type: "part.done",
          sessionId,
          agentHarness,
          messageId: event.part.messageId,
          partId: event.part.id,
          part: event.part,
        });
        break;
      case "message.done":
        this.deps.emit({
          type: "message.done",
          sessionId,
          agentHarness,
          messageId: event.messageId,
          ...(event.stopReason ? { stopReason: event.stopReason } : {}),
          parts: event.parts,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        });
        break;
      case "turn.completed":
        this.deps.emit({
          type: "turn.completed",
          sessionId,
          agentHarness,
          messageId,
          turnId: event.turnId,
          ...(event.finishReason ? { finishReason: event.finishReason } : {}),
          ...(event.tokens ? { tokens: event.tokens } : {}),
          ...(event.cost != null ? { cost: event.cost } : {}),
        });
        break;
    }
  }

  /**
   * Terminal session status, matching the legacy bridge: the product keys
   * agent state off session.idle/cancelled/error — a turn that ends without
   * one of these leaves the session stuck "working". Emitted AFTER the
   * translated turn.completed so the part stream is fully closed before the
   * status flips.
   */
  private emitTerminalStatus(
    sessionId: string,
    state: TranslatorSession,
    event: Extract<LifecycleEvent, { type: "turn.ended" }>
  ): void {
    state.turnId = undefined;
    if (event.stopReason === "error") {
      if (state.errorReported) return;
      // Adapter-reported failures (e.g. codex turn.failed) carry the message
      // only on turn.ended.error.
      state.errorReported = true;
      const classified = classifyError(new Error(event.error?.message ?? "agent turn failed"));
      this.deps.emit({
        type: "session.error",
        sessionId,
        agentHarness: state.harness,
        error: classified.message,
        category: classified.category,
      });
      return;
    }
    if (event.stopReason === "cancelled") {
      // message.cancelled persists the cancellation marker row the frontend
      // uses to render "Turn interrupted" after a reload (legacy parity).
      this.deps.emit({ type: "message.cancelled", sessionId, agentHarness: state.harness });
      this.deps.emit({ type: "session.cancelled", sessionId, agentHarness: state.harness });
      return;
    }
    // Truncation is an error the user must see; engine vocabulary matches the
    // legacy classifier's cases, everything unknown maps to null.
    const stopIssue = classifyStopReason(event.stopReason);
    if (stopIssue) {
      this.deps.emit({
        type: "session.error",
        sessionId,
        agentHarness: state.harness,
        error: stopIssue.message,
        category: stopIssue.category,
      });
      return;
    }
    this.deps.emit({ type: "session.idle", sessionId, agentHarness: state.harness });
  }
}
