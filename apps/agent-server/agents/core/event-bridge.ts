// agent-server/agents/core/event-bridge.ts
// One per-turn bridge from the engine's LifecycleEvent stream to deus's wire:
// native-session capture, the live context gauge, error surfacing (deduped),
// the PartEvent translation, and the terminal session status. This is the
// densest behavior in the core path — keep it in one unit so the whole
// contract is testable with a scripted event sequence (see its test).

import type { LifecycleEvent } from "@agent-server/protocol";
import type { ErrorCategory } from "@shared/enums";
import { EventBroadcaster } from "../../event-broadcaster";
import { classifyError, classifyStopReason } from "../lifecycle";
import { LifecycleToPartEvents } from "./lifecycle-shim";
import type { CoreSession, DeusHarness } from "./session-state";

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

export class CoreEventBridge {
  private readonly shim = new LifecycleToPartEvents();
  private errorReported = false;

  constructor(
    private readonly sessionId: string,
    private readonly harness: DeusHarness,
    private readonly turnId: string,
    private readonly state: CoreSession
  ) {}

  handle(event: LifecycleEvent): void {
    switch (event.type) {
      case "session.created":
        this.state.nativeSessionId = event.nativeSessionId;
        EventBroadcaster.emitAgentSessionId(this.sessionId, event.nativeSessionId);
        return;
      case "session.usage":
        // Merge — Claude reports `size` only on the final result; a later
        // used-only event must not erase the known window size or cost.
        this.state.lastUsage = {
          ...this.state.lastUsage,
          ...event,
          size: event.size ?? this.state.lastUsage?.size,
          cost: event.cost ?? this.state.lastUsage?.cost,
        };
        // Live context gauge: the backend persists it onto the session row
        // (context_token_count / context_used_percent) for the composer UI.
        // Emit the MERGED values — a used-only update with a raw undefined
        // size would desync the persisted count from the stale percent.
        EventBroadcaster.emitSessionContextUsage(this.sessionId, this.harness, {
          used: event.used,
          size: this.state.lastUsage.size,
          cost: this.state.lastUsage.cost,
        });
        return;
      case "error":
        // Recoverable errors (the engine is retrying / the turn continues) are
        // diagnostics, not terminal state — promoting them would flip the UI to
        // an error while the agent is still running AND suppress the real
        // terminal error via the dedupe flag.
        if (event.recoverable) return;
        // Turn errors end the turn structurally (turn.ended stopReason=error);
        // this surfaces the message on deus's session.error channel too.
        this.errorReported = true;
        EventBroadcaster.emitSessionError(
          this.sessionId,
          this.harness,
          event.error,
          ERROR_CATEGORY[event.code ?? ""] ?? "internal"
        );
        return;
      default:
    }

    this.emitParts(event);
    if (event.type === "turn.ended") this.emitTerminalStatus(event);
  }

  private emitParts(event: LifecycleEvent): void {
    const turnId = ("turnId" in event ? event.turnId : undefined) ?? this.turnId;
    for (const partEvent of this.shim.translate(event)) {
      EventBroadcaster.emitPartEvent(this.sessionId, this.harness, turnId, partEvent);
    }
  }

  /**
   * Terminal session status, matching the legacy handlers: the backend and
   * CLI key agent state off session.idle/cancelled/error — a turn that ends
   * without one of these leaves the product stuck "working". Emitted AFTER
   * the translated turn.completed so the part stream is fully closed before
   * the status flips (legacy ordering).
   */
  private emitTerminalStatus(event: Extract<LifecycleEvent, { type: "turn.ended" }>): void {
    // The turn is over — cancel() and the checkpoint hooks key "turn active"
    // off state.turnId; a stale id would let a later session-stop overwrite
    // the end checkpoint with post-turn edits.
    this.state.turnId = undefined;
    if (event.stopReason === "error") {
      if (this.errorReported) return;
      // Adapter-reported failures (e.g. codex turn.failed) carry the message
      // only on turn.ended.error.
      this.errorReported = true;
      const classified = classifyError(new Error(event.error?.message ?? "agent turn failed"));
      EventBroadcaster.emitSessionError(
        this.sessionId,
        this.harness,
        classified.message,
        classified.category
      );
      return;
    }
    if (event.stopReason === "cancelled") {
      // message.cancelled persists the cancellation marker row the frontend
      // uses to render "Turn interrupted" after a reload (legacy parity).
      EventBroadcaster.emitMessageCancelled(this.sessionId, this.harness);
      EventBroadcaster.emitSessionCancelled(this.sessionId, this.harness);
      return;
    }
    // Truncation is an error the user must see (legacy classifyStopReason;
    // engine vocabulary matches its cases, everything unknown maps to null).
    const stopIssue = classifyStopReason(event.stopReason);
    if (stopIssue) {
      EventBroadcaster.emitSessionError(
        this.sessionId,
        this.harness,
        stopIssue.message,
        stopIssue.category
      );
      return;
    }
    EventBroadcaster.emitSessionIdle(this.sessionId, this.harness);
    this.fetchTitleOnce();
  }

  /**
   * Best-effort session title after the first successful claude turn: the SDK
   * auto-summarizes sessions; the backend names the session AND an untitled
   * workspace from `session.title` (legacy parity). Fire-and-forget.
   */
  private fetchTitleOnce(): void {
    if (this.harness !== "claude" || this.state.titleFetched) return;
    const { cwd, nativeSessionId } = this.state;
    if (!cwd || !nativeSessionId) return;
    void (async () => {
      try {
        const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
        const sessions = await listSessions({ dir: cwd, limit: 20 });
        const title = sessions.find((s) => s.sessionId === nativeSessionId)?.summary;
        if (title) {
          // Flag only on success: the SDK summary usually lags the first turn,
          // so keep retrying at each turn end until one exists.
          this.state.titleFetched = true;
          EventBroadcaster.emitSessionTitle(this.sessionId, this.harness, title);
        }
      } catch (error) {
        console.error(`[core] title fetch failed for ${this.sessionId}:`, error);
      }
    })();
  }
}
