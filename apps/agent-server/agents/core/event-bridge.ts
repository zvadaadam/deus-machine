// agent-server/agents/core/event-bridge.ts
// One per-turn bridge from the engine's LifecycleEvent stream to deus's wire:
// native-session capture, the live context gauge, error surfacing (deduped),
// the PartEvent translation, and the terminal session status. This is the
// densest behavior in the core path — keep it in one unit so the whole
// contract is testable with a scripted event sequence (see its test).

import type { LifecycleEvent } from "@agent-server/protocol";
import type { ErrorCategory } from "@shared/enums";
import { EventBroadcaster } from "../../event-broadcaster";
import { classifyError } from "../lifecycle";
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
        EventBroadcaster.emitAgentSessionId(this.sessionId, event.nativeSessionId);
        return;
      case "session.usage":
        this.state.lastUsage = event;
        // Live context gauge: the backend persists it onto the session row
        // (context_token_count / context_used_percent) for the composer UI.
        EventBroadcaster.emitSessionContextUsage(this.sessionId, this.harness, {
          used: event.used,
          size: event.size,
          cost: event.cost,
        });
        return;
      case "error":
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
      EventBroadcaster.emitSessionCancelled(this.sessionId, this.harness);
      return;
    }
    EventBroadcaster.emitSessionIdle(this.sessionId, this.harness);
  }
}
