// The LifecycleEvent→AgentEvent translator: terminal status derivation, error
// dedupe, gauge forwarding with sticky merge, native-id capture, and ordering.
// This is the densest logic on the migrated wire — asserted against scripted
// envelope sequences (ported from the agent-server's CoreEventBridge test).
import { beforeEach, describe, expect, it } from "vitest";
import type { LifecycleEvent, WireEventEnvelope } from "@zvada/agent-server/protocol";
import type { AgentEvent } from "@shared/agent-events";
import { LifecycleTranslator } from "../../../src/services/agent/translate/translator";

const T = 1_700_000_000_000;

function turnEnded(
  stopReason: "end_turn" | "cancelled" | "error" | "max_tokens",
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

describe("LifecycleTranslator", () => {
  let emitted: AgentEvent[];
  let translator: LifecycleTranslator;
  let seq: number;

  const feed = (event: LifecycleEvent, sessionId = "s1") => {
    const envelope: WireEventEnvelope = { sessionId, seq: seq++, event };
    translator.handle(envelope);
  };
  const types = () => emitted.map((e) => e.type);

  beforeEach(() => {
    emitted = [];
    seq = 1;
    translator = new LifecycleTranslator({ emit: (event) => emitted.push(event) });
    translator.beginTurn("s1", "claude", "t1");
    // beginTurn emits session.started (status → working); drop it from the
    // per-scenario assertions.
    emitted.length = 0;
  });

  it("emits session.started on beginTurn", () => {
    translator.beginTurn("s2", "codex-sdk", "t9");
    expect(emitted).toEqual([
      { type: "session.started", sessionId: "s2", agentHarness: "codex-sdk" },
    ]);
  });

  it("emits session.idle AFTER the translated turn.completed", () => {
    feed(turnEnded("end_turn"));
    expect(types()).toEqual(["turn.completed", "session.idle"]);
  });

  it("maps a cancelled turn to the marker row + session.cancelled", () => {
    feed(turnEnded("cancelled"));
    // message.cancelled persists the "Turn interrupted" marker; it must land
    // before the status flip so a reload mid-emission still shows the marker.
    expect(types()).toEqual(["turn.completed", "message.cancelled", "session.cancelled"]);
  });

  it("surfaces an adapter-reported turn failure exactly once", () => {
    feed(turnEnded("error", { name: "AgentError", message: "boom" }));
    expect(types()).toEqual(["turn.completed", "session.error"]);
    const error = emitted.find((e) => e.type === "session.error");
    expect(error).toMatchObject({ sessionId: "s1", error: expect.stringContaining("boom") });
  });

  it("dedupes: a runtime error event followed by an error-stopped turn emits ONE session.error", () => {
    feed({
      type: "error",
      sessionId: "s1",
      turnId: "t1",
      error: "spawn failed",
      recoverable: false,
      code: "process_exit",
      timestamp: T,
    });
    feed(turnEnded("error", { name: "AgentError", message: "spawn failed" }));
    expect(types()).toEqual(["session.error", "turn.completed"]);
    expect(emitted[0]).toMatchObject({
      type: "session.error",
      sessionId: "s1",
      agentHarness: "claude",
      error: "spawn failed",
      category: "process_exit",
    });
  });

  it("forwards the context gauge with the harness attached", () => {
    feed({
      type: "session.usage",
      sessionId: "s1",
      turnId: "t1",
      used: 1234,
      size: 200_000,
      cost: 0.5,
      timestamp: T,
    });
    expect(emitted).toEqual([
      {
        type: "session.contextUsage",
        sessionId: "s1",
        agentHarness: "claude",
        used: 1234,
        size: 200_000,
        cost: 0.5,
      },
    ]);
  });

  it("captures the native session id as agent.session_id", () => {
    feed({
      type: "session.created",
      sessionId: "s1",
      nativeSessionId: "native-1",
      harness: "claude-code",
      timestamp: T,
    });
    expect(emitted).toEqual([
      { type: "agent.session_id", sessionId: "s1", agentSessionId: "native-1" },
    ]);
  });

  it("ignores recoverable errors and still surfaces the eventual terminal error", () => {
    feed({
      type: "error",
      sessionId: "s1",
      turnId: "t1",
      error: "resume failed, retrying fresh",
      recoverable: true,
      timestamp: T,
    });
    expect(emitted).toEqual([]); // diagnostics only — UI must not flip to error
    feed(turnEnded("error", { name: "AgentError", message: "boom" }));
    expect(types()).toEqual(["turn.completed", "session.error"]);
  });

  it("merges usage: a used-only update keeps the known window size and cost", () => {
    feed({
      type: "session.usage",
      sessionId: "s1",
      turnId: "t1",
      used: 1000,
      size: 200_000,
      cost: 0.5,
      timestamp: T,
    });
    feed({ type: "session.usage", sessionId: "s1", turnId: "t1", used: 2000, timestamp: T + 1 });
    expect(emitted[1]).toMatchObject({ used: 2000, size: 200_000, cost: 0.5 });
  });

  it("keeps the usage merge across turns (beginTurn does not reset it)", () => {
    feed({
      type: "session.usage",
      sessionId: "s1",
      turnId: "t1",
      used: 1000,
      size: 200_000,
      timestamp: T,
    });
    translator.beginTurn("s1", "claude", "t2");
    emitted.length = 0;
    feed({ type: "session.usage", sessionId: "s1", turnId: "t2", used: 3000, timestamp: T + 2 });
    expect(emitted[0]).toMatchObject({ used: 3000, size: 200_000 });
  });

  it("surfaces output-token truncation (max_tokens) as a session error", () => {
    feed(turnEnded("max_tokens"));
    expect(types()).toEqual(["turn.completed", "session.error"]);
    expect(emitted[1]).toMatchObject({
      error: expect.stringContaining("truncated"),
      category: "context_limit",
    });
  });

  it("resolves the harness via the DB fallback for events without a beginTurn", () => {
    const fallback = new LifecycleTranslator({
      emit: (event) => emitted.push(event),
      resolveHarness: (sessionId) => (sessionId === "replayed" ? "codex-server" : undefined),
    });
    fallback.handle({
      sessionId: "replayed",
      seq: 1,
      event: {
        type: "turn.ended",
        turnId: "t1",
        sessionId: "replayed",
        stopReason: "end_turn",
        timestamp: T,
      },
    });
    expect(types()).toEqual(["turn.completed", "session.idle"]);
    expect(emitted[1]).toMatchObject({ sessionId: "replayed", agentHarness: "codex-server" });
  });

  it("drops events for sessions with no known harness", () => {
    feed(turnEnded("end_turn"), "unknown-session");
    expect(emitted).toEqual([]);
  });

  it("translates the full part stream of a simple text turn", () => {
    const events: LifecycleEvent[] = [
      { type: "turn.started", sessionId: "s1", turnId: "t1", timestamp: T },
      {
        type: "message.started",
        turnId: "t1",
        messageId: "m1",
        outputIndex: 0,
        role: "assistant",
        timestamp: T,
      },
      {
        type: "message.part",
        turnId: "t1",
        messageId: "m1",
        outputIndex: 0,
        partIndex: 0,
        part: {
          type: "text",
          id: "p1",
          sessionId: "s1",
          messageId: "m1",
          text: "Hello",
          state: "done",
        },
        timestamp: T,
      },
      { type: "message.ended", turnId: "t1", messageId: "m1", timestamp: T },
      turnEnded("end_turn"),
    ];
    for (const event of events) feed(event);
    expect(types()).toEqual([
      "turn.started",
      "message.created",
      "part.created",
      "part.done",
      "message.done",
      "turn.completed",
      "session.idle",
    ]);
    // The deus turn.started carries the turnId as its messageId (legacy wire shape).
    expect(emitted[0]).toMatchObject({ messageId: "t1", turnId: "t1" });
  });
});
