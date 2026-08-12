// The per-turn LifecycleEvent→deus-wire bridge: terminal status derivation,
// error dedupe, gauge forwarding, native-id capture, and ordering. This is the
// densest logic in the core path — asserted here against a scripted sequence
// and real EventBroadcaster spies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleEvent } from "@agent-server/protocol";
import { EventBroadcaster } from "../event-broadcaster";
import { CoreEventBridge } from "../agents/core/event-bridge";
import type { CoreSession } from "../agents/core/session-state";

// The bridge's fire-and-forget title fetch dynamic-imports the SDK; stub it so
// tests neither touch ~/.claude nor depend on the SDK being importable here.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  listSessions: vi.fn(async () => [{ sessionId: "native-1", summary: "Fix login flow" }]),
}));

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
    vi.spyOn(EventBroadcaster, "emitMessageCancelled").mockImplementation(
      record("messageCancelled")
    );
    vi.spyOn(EventBroadcaster, "emitSessionIdle").mockImplementation(record("sessionIdle"));
    vi.spyOn(EventBroadcaster, "emitSessionTitle").mockImplementation(record("sessionTitle"));
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

  it("maps a cancelled turn to the marker row + session.cancelled", () => {
    bridge.handle(turnEnded("cancelled"));
    // message.cancelled persists the "Turn interrupted" marker; it must land
    // before the status flip so a reload mid-emission still shows the marker.
    expect(calls).toEqual(["part:turn.completed", "messageCancelled", "sessionCancelled"]);
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
    expect(state.nativeSessionId).toBe("native-1");
  });

  it("ignores recoverable errors and still surfaces the eventual terminal error", () => {
    bridge.handle({
      type: "error",
      sessionId: "s1",
      turnId: "t1",
      error: "resume failed, retrying fresh",
      recoverable: true,
      timestamp: T,
    });
    expect(calls).toEqual([]); // diagnostics only — UI must not flip to error
    bridge.handle(turnEnded("error", { name: "AgentError", message: "boom" }));
    expect(calls).toEqual(["part:turn.completed", "sessionError"]);
  });

  it("merges usage: a used-only update keeps the known window size and cost", () => {
    bridge.handle({
      type: "session.usage",
      sessionId: "s1",
      turnId: "t1",
      used: 1000,
      size: 200_000,
      cost: 0.5,
      timestamp: T,
    });
    bridge.handle({
      type: "session.usage",
      sessionId: "s1",
      turnId: "t1",
      used: 2000,
      timestamp: T + 1,
    });
    expect(state.lastUsage?.used).toBe(2000);
    expect(state.lastUsage?.size).toBe(200_000);
    expect(state.lastUsage?.cost).toBe(0.5);
  });

  it("surfaces output-token truncation (max_tokens) as a session error", () => {
    bridge.handle({
      type: "turn.ended",
      turnId: "t1",
      sessionId: "s1",
      stopReason: "max_tokens",
      timestamp: T,
    });
    expect(calls).toEqual(["part:turn.completed", "sessionError"]);
    expect(EventBroadcaster.emitSessionError).toHaveBeenCalledWith(
      "s1",
      "claude",
      expect.stringContaining("truncated"),
      "context_limit"
    );
  });

  describe("title fetch after the first successful turn", () => {
    it("fetches the SDK summary once, claude-only, when cwd + native id are known", async () => {
      state.cwd = "/tmp/w";
      state.nativeSessionId = "native-1";
      bridge.handle(turnEnded("end_turn"));
      await vi.waitFor(() =>
        expect(EventBroadcaster.emitSessionTitle).toHaveBeenCalledWith(
          "s1",
          "claude",
          "Fix login flow"
        )
      );
      // Flag flips only on SUCCESS (a missing summary retries next turn).
      expect(state.titleFetched).toBe(true);
      // Second successful turn: no refetch.
      vi.mocked(EventBroadcaster.emitSessionTitle).mockClear();
      bridge.handle(turnEnded("end_turn"));
      await new Promise((r) => setImmediate(r));
      expect(EventBroadcaster.emitSessionTitle).not.toHaveBeenCalled();
    });

    it("skips when the native session id is unknown", async () => {
      state.cwd = "/tmp/w";
      bridge.handle(turnEnded("end_turn"));
      expect(state.titleFetched).toBeFalsy();
      await new Promise((r) => setImmediate(r));
      expect(EventBroadcaster.emitSessionTitle).not.toHaveBeenCalled();
    });

    it("skips for codex harnesses", async () => {
      const codexState: CoreSession = { cwd: "/tmp/w", nativeSessionId: "native-1" };
      const codexBridge = new CoreEventBridge("s2", "codex-server", "t1", codexState);
      codexBridge.handle({
        type: "turn.ended",
        turnId: "t1",
        sessionId: "s2",
        stopReason: "end_turn",
        timestamp: T,
      });
      expect(codexState.titleFetched).toBeFalsy();
      await new Promise((r) => setImmediate(r));
      expect(EventBroadcaster.emitSessionTitle).not.toHaveBeenCalled();
    });
  });
});
