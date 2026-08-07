// The per-turn LifecycleEvent→deus-wire bridge: terminal status derivation,
// error dedupe, gauge forwarding, native-id capture, and ordering. This is the
// densest logic in the core path — asserted here against a scripted sequence
// and real EventBroadcaster spies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleEvent } from "@agent-server/protocol";
import { EventBroadcaster } from "../event-broadcaster";
import { CoreEventBridge } from "../agents/core/event-bridge";
import type { CoreSession } from "../agents/core/session-state";

const T = 1_700_000_000_000;

function turnEnded(
  stopReason: "end_turn" | "cancelled" | "error",
  error?: { name: string; message: string }
): LifecycleEvent {
  return {
    type: "turn.ended",
    turnId: "t1",
    sessionId: "s1",
    stopReason,
    ...(error ? { error } : {}),
    timestamp: T,
  };
}

describe("CoreEventBridge", () => {
  const calls: string[] = [];
  let state: CoreSession;
  let bridge: CoreEventBridge;

  beforeEach(() => {
    calls.length = 0;
    const record =
      (name: string) =>
      (..._args: unknown[]) => {
        calls.push(name);
      };
    vi.spyOn(EventBroadcaster, "emitAgentSessionId").mockImplementation(record("agentSessionId"));
    vi.spyOn(EventBroadcaster, "emitSessionContextUsage").mockImplementation(
      record("contextUsage")
    );
    vi.spyOn(EventBroadcaster, "emitSessionError").mockImplementation(record("sessionError"));
    vi.spyOn(EventBroadcaster, "emitSessionCancelled").mockImplementation(
      record("sessionCancelled")
    );
    vi.spyOn(EventBroadcaster, "emitSessionIdle").mockImplementation(record("sessionIdle"));
    vi.spyOn(EventBroadcaster, "emitPartEvent").mockImplementation((_s, _h, _m, event) => {
      calls.push(`part:${event.type}`);
    });
    state = {};
    bridge = new CoreEventBridge("s1", "claude", "t1", state);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits session.idle AFTER the translated turn.completed", () => {
    bridge.handle(turnEnded("end_turn"));
    expect(calls).toEqual(["part:turn.completed", "sessionIdle"]);
  });

  it("maps a cancelled turn to session.cancelled", () => {
    bridge.handle(turnEnded("cancelled"));
    expect(calls).toEqual(["part:turn.completed", "sessionCancelled"]);
  });

  it("surfaces an adapter-reported turn failure exactly once", () => {
    bridge.handle(turnEnded("error", { name: "AgentError", message: "boom" }));
    expect(calls).toEqual(["part:turn.completed", "sessionError"]);
    expect(EventBroadcaster.emitSessionError).toHaveBeenCalledWith(
      "s1",
      "claude",
      expect.stringContaining("boom"),
      expect.any(String)
    );
  });

  it("dedupes: a runtime error event followed by an error-stopped turn emits ONE session.error", () => {
    bridge.handle({
      type: "error",
      sessionId: "s1",
      turnId: "t1",
      error: "spawn failed",
      recoverable: false,
      code: "process_exit",
      timestamp: T,
    });
    bridge.handle(turnEnded("error", { name: "AgentError", message: "spawn failed" }));
    expect(calls).toEqual(["sessionError", "part:turn.completed"]);
    expect(EventBroadcaster.emitSessionError).toHaveBeenCalledTimes(1);
    expect(EventBroadcaster.emitSessionError).toHaveBeenCalledWith(
      "s1",
      "claude",
      "spawn failed",
      "process_exit"
    );
  });

  it("caches usage on the session state and forwards the context gauge", () => {
    bridge.handle({
      type: "session.usage",
      sessionId: "s1",
      turnId: "t1",
      used: 1234,
      size: 200_000,
      cost: 0.5,
      timestamp: T,
    });
    expect(calls).toEqual(["contextUsage"]);
    expect(state.lastUsage?.used).toBe(1234);
    expect(EventBroadcaster.emitSessionContextUsage).toHaveBeenCalledWith("s1", "claude", {
      used: 1234,
      size: 200_000,
      cost: 0.5,
    });
  });

  it("captures the native session id", () => {
    bridge.handle({
      type: "session.created",
      sessionId: "s1",
      nativeSessionId: "native-1",
      harness: "claude-code",
      timestamp: T,
    });
    expect(EventBroadcaster.emitAgentSessionId).toHaveBeenCalledWith("s1", "native-1");
  });
});
