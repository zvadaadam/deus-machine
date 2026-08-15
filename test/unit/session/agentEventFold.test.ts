/**
 * The fold that turns the canonical agent stream into the message cache.
 *
 * This is the highest-risk logic in the session feature — upsert-by-part-id,
 * the delta accumulator and its field-ownership wipe, the seq cursor, the
 * user-echo reconcile and the turn-accounting mirror — and it shipped with no
 * tests, which is exactly why the echo reconcile could be dead code without
 * anyone noticing. Everything here runs against a REAL QueryClient: the fold
 * IS its cache writes, so mocking setQueryData would only pin the call shape.
 */

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  advanceCursor,
  createDeltaBuffer,
  flushDeltas,
  messagesKey,
  routeEnvelope,
  type AgentStreamContext,
} from "../../../apps/web/src/features/session/lib/agentEventFold";
import { createOptimisticUserMessage } from "../../../apps/web/src/features/session/lib/optimisticMessage";
import type { PaginatedMessages } from "../../../apps/web/src/features/session/api/session.service";
import type { Message } from "../../../shared/types/session";
import type { LifecycleEvent, Part, WireEventEnvelope } from "../../../shared/protocol-types";

const SESSION = "sess-1";
const OTHER = "sess-2";
const TURN = "turn-1";
const T = Date.parse("2026-08-15T10:00:00.000Z");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  ctx: AgentStreamContext;
  qc: QueryClient;
  scheduleFlush: ReturnType<typeof vi.fn>;
  requestRefetch: ReturnType<typeof vi.fn>;
  /** Feed one envelope, auto-numbering `seq` per session. */
  feed: (event: LifecycleEvent, over?: Partial<WireEventEnvelope>) => void;
  page: (sessionId?: string) => PaginatedMessages | undefined;
  /** Apply whatever the deltas accumulated, as the animation frame would. */
  flush: (sessionId?: string) => void;
}

function harness(activeSessionId = SESSION): Harness {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scheduleFlush = vi.fn();
  const requestRefetch = vi.fn();
  const ctx: AgentStreamContext = {
    queryClient: qc,
    activeSessionId,
    buffer: createDeltaBuffer(),
    cursors: new Map(),
    scheduleFlush,
    requestRefetch,
  };
  const seqs = new Map<string, number>();

  return {
    ctx,
    qc,
    scheduleFlush,
    requestRefetch,
    feed(event, over = {}) {
      const sessionId = over.sessionId ?? sessionOf(event) ?? activeSessionId;
      const next = (seqs.get(sessionId) ?? 0) + 1;
      seqs.set(sessionId, next);
      routeEnvelope(ctx, { sessionId, seq: next, event, ...over } as WireEventEnvelope);
    },
    page(sessionId = activeSessionId) {
      return qc.getQueryData<PaginatedMessages>(messagesKey(sessionId));
    },
    flush(sessionId = activeSessionId) {
      flushDeltas(qc, sessionId, ctx.buffer);
    },
  };
}

function sessionOf(event: LifecycleEvent): string | undefined {
  return (event as { sessionId?: string }).sessionId;
}

function seed(qc: QueryClient, sessionId: string, messages: Message[]): void {
  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), {
    messages,
    compactions: [],
    has_older: false,
    has_newer: false,
  });
}

// ---- event builders (engine shapes, verbatim) ----

function started(over: Partial<Record<string, unknown>> = {}): LifecycleEvent {
  return {
    type: "message.started",
    sessionId: SESSION,
    turnId: TURN,
    messageId: "a1",
    outputIndex: 1,
    role: "assistant",
    timestamp: T,
    ...over,
  } as LifecycleEvent;
}

function textPart(id: string, text: string, over: Partial<Record<string, unknown>> = {}): Part {
  return {
    type: "text",
    id,
    sessionId: SESSION,
    messageId: "a1",
    text,
    ...over,
  } as Part;
}

function partEvent(part: Part, over: Partial<Record<string, unknown>> = {}): LifecycleEvent {
  return {
    type: "message.part",
    sessionId: SESSION,
    turnId: TURN,
    messageId: part.messageId,
    outputIndex: 1,
    partIndex: 0,
    part,
    timestamp: T,
    ...over,
  } as LifecycleEvent;
}

function delta(partId: string, text: string): LifecycleEvent {
  return {
    type: "message.part.delta",
    sessionId: SESSION,
    turnId: TURN,
    messageId: "a1",
    partId,
    delta: { type: "text", text },
    timestamp: T,
  } as LifecycleEvent;
}

function turnEnded(over: Partial<Record<string, unknown>> = {}): LifecycleEvent {
  return {
    type: "turn.ended",
    sessionId: SESSION,
    turnId: TURN,
    stopReason: "end_turn",
    timestamp: T,
    ...over,
  } as LifecycleEvent;
}

// ===========================================================================
// Parts: snapshots are authoritative
// ===========================================================================

describe("message.part — upsert by part id", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.feed(started());
  });

  it("appends a new part and replaces an existing one in place", () => {
    h.feed(partEvent(textPart("p1", "one")));
    h.feed(partEvent(textPart("p2", "two")));
    h.feed(partEvent(textPart("p1", "one (final)", { state: "done" })));

    const parts = h.page()!.messages[0].parts!;
    expect(parts.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect((parts[0] as { text: string }).text).toBe("one (final)");
  });

  it("drops a part whose message is not cached instead of inventing a row", () => {
    h.feed(partEvent(textPart("ghost", "x", { messageId: "nope" }), { messageId: "nope" }));

    expect(h.page()!.messages).toHaveLength(1);
    expect(h.page()!.messages[0].parts).toEqual([]);
  });
});

// ===========================================================================
// Deltas: PROTOCOL §7.3-2 field ownership
// ===========================================================================

describe("message.part.delta — the accumulator", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.feed(started());
    h.feed(partEvent(textPart("p1", "")));
  });

  const text = (h: Harness) => (h.page()!.messages[0].parts![0] as { text: string }).text;

  it("appends deltas onto the part's text", () => {
    h.feed(delta("p1", "A"));
    h.feed(delta("p1", "B"));
    h.flush();

    expect(text(h)).toBe("AB");
    expect(h.scheduleFlush).toHaveBeenCalled();
  });

  it("a snapshot WINS over everything buffered for that part", () => {
    h.feed(delta("p1", "A"));
    h.feed(delta("p1", "B"));
    h.feed(partEvent(textPart("p1", "C", { state: "done" })));
    h.flush();

    // The pending "AB" is dropped, not re-appended after the snapshot.
    expect(text(h)).toBe("C");
  });

  it("deltas after a snapshot append to the snapshot", () => {
    h.feed(partEvent(textPart("p1", "C")));
    h.feed(delta("p1", "D"));
    h.flush();

    expect(text(h)).toBe("CD");
  });

  it("a flush with nothing pending leaves the cache object identical", () => {
    const before = h.page();
    h.flush();
    expect(h.page()).toBe(before);
  });
});

// ===========================================================================
// C2: the user echo replaces the composer's bubble
// ===========================================================================

describe("message.started{role:user} — echo reconciliation", () => {
  const echo = () => started({ messageId: "u-engine", role: "user", outputIndex: 0, turnId: TURN });

  it("replaces the optimistic bubble in place — one bubble, not two", () => {
    const h = harness();
    const bubble = createOptimisticUserMessage({
      sessionId: SESSION,
      turnId: TURN,
      content: "what is 2+2?",
    });
    seed(h.qc, SESSION, [bubble]);

    h.feed(echo());

    const messages = h.page()!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("u-engine");
    expect(messages[0].turn_id).toBe(TURN);
    // The typed text keeps rendering until the echo's own parts land.
    expect(messages[0].parts).toEqual(bubble.parts);
  });

  it("regression: an echo whose turn id does not match appends instead of eating a row", () => {
    const h = harness();
    const bubble = createOptimisticUserMessage({
      sessionId: SESSION,
      turnId: "some-other-turn",
      content: "still mine",
    });
    seed(h.qc, SESSION, [bubble]);

    h.feed(echo());

    expect(h.page()!.messages.map((m) => m.id)).toEqual([bubble.id, "u-engine"]);
  });

  it("regression: the echo's own parts evict the local placeholders (no doubled text)", () => {
    const h = harness();
    seed(h.qc, SESSION, [
      createOptimisticUserMessage({ sessionId: SESSION, turnId: TURN, content: "hello" }),
    ]);

    h.feed(echo());
    h.feed(
      partEvent(textPart("engine-p1", "hello", { messageId: "u-engine" }), {
        messageId: "u-engine",
      })
    );

    const parts = h.page()!.messages[0].parts!;
    expect(parts.map((p) => p.id)).toEqual(["engine-p1"]);
  });

  it("regression: an echo that already landed via q:delta does not leave a duplicate", () => {
    const h = harness();
    const bubble = createOptimisticUserMessage({
      sessionId: SESSION,
      turnId: TURN,
      content: "hi",
    });
    // The backend invalidates BEFORE it pushes the envelope, so the persisted
    // row usually arrives first. The envelope must then retire the bubble.
    seed(h.qc, SESSION, [bubble, { ...bubble, id: "u-engine", parts: [], seq: 4 } as Message]);

    h.feed(echo());

    expect(h.page()!.messages.map((m) => m.id)).toEqual(["u-engine"]);
  });

  it("seeds a page for the active session when events beat the first fetch", () => {
    const h = harness();
    h.feed(started());
    expect(h.page()!.messages.map((m) => m.id)).toEqual(["a1"]);
  });
});

// ===========================================================================
// I3: the seq cursor
// ===========================================================================

describe("seq cursor", () => {
  it("does not treat the first envelope of a session as a gap", () => {
    const cursors = new Map<string, number>();
    expect(advanceCursor(cursors, SESSION, 42)).toBe("ok");
  });

  it("flags a jump as a gap and keeps the cursor on what actually arrived", () => {
    const cursors = new Map([[SESSION, 5]]);
    expect(advanceCursor(cursors, SESSION, 9)).toBe("gap");
    expect(cursors.get(SESSION)).toBe(9);
    expect(advanceCursor(cursors, SESSION, 10)).toBe("ok");
  });

  it("recovers when the log restarts — the cursor moves DOWN, not Math.max", () => {
    const cursors = new Map([[SESSION, 50]]);
    // agent-server restarted: per-session seq numbers from 1 again.
    expect(advanceCursor(cursors, SESSION, 1)).toBe("reset");
    expect(cursors.get(SESSION)).toBe(1);
    // Gap detection is still alive afterwards — clamping killed it forever.
    expect(advanceCursor(cursors, SESSION, 2)).toBe("ok");
    expect(advanceCursor(cursors, SESSION, 7)).toBe("gap");
  });

  it("ignores a re-delivered envelope so a delta is not counted twice", () => {
    const cursors = new Map([[SESSION, 5]]);
    expect(advanceCursor(cursors, SESSION, 5)).toBe("duplicate");
    expect(cursors.get(SESSION)).toBe(5);
  });

  it("tracks each session's stream separately", () => {
    const cursors = new Map<string, number>();
    expect(advanceCursor(cursors, SESSION, 7)).toBe("ok");
    expect(advanceCursor(cursors, OTHER, 1)).toBe("ok");
    expect(advanceCursor(cursors, SESSION, 8)).toBe("ok");
  });
});

describe("routeEnvelope — gap handling", () => {
  it("asks for exactly one refetch per gap, and folds the event anyway", () => {
    const h = harness();
    h.feed(started());
    h.feed(partEvent(textPart("p1", "kept")), { seq: 9 });

    expect(h.requestRefetch).toHaveBeenCalledTimes(1);
    expect(h.requestRefetch).toHaveBeenCalledWith(SESSION);
    expect(h.page()!.messages[0].parts).toHaveLength(1);
  });

  it("drops a duplicate envelope entirely — no fold, no refetch", () => {
    const h = harness();
    h.feed(started());
    h.feed(partEvent(textPart("p1", "")), { seq: 2 });
    h.feed(delta("p1", "A"), { seq: 2 });
    h.flush();

    expect((h.page()!.messages[0].parts![0] as { text: string }).text).toBe("");
    expect(h.requestRefetch).not.toHaveBeenCalled();
  });

  it("refetches the message page when a compaction marker lands", () => {
    const h = harness();
    h.feed({
      type: "session.compaction",
      sessionId: SESSION,
      turnId: TURN,
      compactionId: "c1",
      status: "completed",
      timestamp: T,
    } as LifecycleEvent);

    expect(h.requestRefetch).toHaveBeenCalledWith(SESSION);
  });
});

// ===========================================================================
// turn.ended: accounting lands on the right row
// ===========================================================================

describe("turn.ended — accounting mirror", () => {
  it("writes tokens/cost/stopReason onto the turn's last TOP-LEVEL assistant message", () => {
    const h = harness();
    h.feed(started({ messageId: "u1", role: "user", outputIndex: 0 }));
    h.feed(started({ messageId: "a1" }));
    h.feed(started({ messageId: "sub", parentToolCallId: "task-1" }));
    h.feed(started({ messageId: "a2" }));

    h.feed(turnEnded({ tokens: { input: 100, output: 20 }, cost: 0.25, stopReason: "refusal" }));

    const byId = new Map(h.page()!.messages.map((m) => [m.id, m]));
    expect(byId.get("a2")).toMatchObject({
      tokens: JSON.stringify({ input: 100, output: 20 }),
      cost: 0.25,
      turn_stop_reason: "refusal",
    });
    expect(byId.get("sub")!.tokens).toBeUndefined();
    expect(byId.get("a1")!.tokens).toBeUndefined();
  });

  it("stamps cancelled_at on the interrupted turn", () => {
    const h = harness();
    h.feed(started({ messageId: "a1" }));
    h.feed(turnEnded({ stopReason: "cancelled", timestamp: T + 5 }));

    expect(h.page()!.messages[0].cancelled_at).toBe(new Date(T + 5).toISOString());
  });

  it("I5: a cancel before the first assistant message still leaves a marker", () => {
    const h = harness();
    h.feed(started({ messageId: "u1", role: "user", outputIndex: 0 }));
    h.feed(turnEnded({ stopReason: "cancelled", timestamp: T + 5 }));

    const marker = h.page()!.messages[1];
    expect(marker).toMatchObject({
      id: `cancelled-${TURN}`,
      role: "assistant",
      turn_id: TURN,
      turn_stop_reason: "cancelled",
      cancelled_at: new Date(T + 5).toISOString(),
    });
  });

  it("a clean turn with no assistant message adds nothing", () => {
    const h = harness();
    h.feed(started({ messageId: "u1", role: "user", outputIndex: 0 }));
    h.feed(turnEnded({ stopReason: "end_turn" }));

    expect(h.page()!.messages).toHaveLength(1);
  });
});

// ===========================================================================
// I4: sessions the user is not looking at
// ===========================================================================

describe("background sessions", () => {
  it("delivers turn accounting to a session whose panel is not mounted", () => {
    // Active session is SESSION; the turn that ends belongs to OTHER, whose
    // page is cached from an earlier visit. The `messages` subscription is
    // delta-only, so an UPDATE has no other way in.
    const h = harness(SESSION);
    seed(h.qc, OTHER, [
      { id: "b1", session_id: OTHER, seq: 1, role: "assistant", content: null, turn_id: TURN },
    ]);

    h.feed(
      turnEnded({
        sessionId: OTHER,
        stopReason: "cancelled",
        tokens: { input: 9, output: 1 },
        cost: 0.02,
        timestamp: T + 9,
      }),
      { sessionId: OTHER }
    );

    expect(h.page(OTHER)!.messages[0]).toMatchObject({
      turn_stop_reason: "cancelled",
      cancelled_at: new Date(T + 9).toISOString(),
      tokens: JSON.stringify({ input: 9, output: 1 }),
      cost: 0.02,
    });
    // …and the active session is untouched.
    expect(h.page(SESSION)).toBeUndefined();
  });

  it("keeps a background transcript current: new messages and their parts land", () => {
    const h = harness(SESSION);
    seed(h.qc, OTHER, []);

    h.feed(started({ sessionId: OTHER, messageId: "b1" }), { sessionId: OTHER });
    h.feed(
      partEvent(textPart("bp1", "away", { sessionId: OTHER, messageId: "b1" }), {
        sessionId: OTHER,
        messageId: "b1",
      }),
      { sessionId: OTHER }
    );

    expect(h.page(OTHER)!.messages[0].parts!.map((p) => p.id)).toEqual(["bp1"]);
  });

  it("never invents a page for a session that was never opened", () => {
    const h = harness(SESSION);

    h.feed(started({ sessionId: OTHER, messageId: "b1" }), { sessionId: OTHER });

    expect(h.page(OTHER)).toBeUndefined();
  });

  it("skips deltas for background sessions — the snapshot restates them", () => {
    const h = harness(SESSION);
    seed(h.qc, OTHER, []);
    h.feed(started({ sessionId: OTHER, messageId: "b1" }), { sessionId: OTHER });
    h.feed(
      partEvent(textPart("bp1", "snap", { sessionId: OTHER, messageId: "b1" }), {
        sessionId: OTHER,
        messageId: "b1",
      }),
      { sessionId: OTHER }
    );

    h.feed({ ...(delta("bp1", "ignored") as object), sessionId: OTHER } as LifecycleEvent, {
      sessionId: OTHER,
    });
    flushDeltas(h.qc, OTHER, h.ctx.buffer);

    expect((h.page(OTHER)!.messages[0].parts![0] as { text: string }).text).toBe("snap");
    expect(h.scheduleFlush).not.toHaveBeenCalled();
  });
});
