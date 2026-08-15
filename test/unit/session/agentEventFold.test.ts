/**
 * The projection that turns the canonical agent stream into the message cache.
 *
 * The FOLD is the engine's (`reduceConversationWithChanges`), and its rules —
 * upsert by part id, snapshots beating deltas, replay convergence, the seq
 * cursor's four verdicts — are tested in the package. What is deus's, and what
 * is tested here, is everything downstream of `changes`: which SQLite-row
 * writes each change implies, which columns survive them, the two delivery
 * grades, and the routing policy for a browser that cannot replay a hole.
 *
 * Everything runs against a REAL QueryClient: the projection IS its cache
 * writes, so mocking setQueryData would only pin the call shape.
 */

import { QueryClient } from "@tanstack/react-query";
import { createUserEchoParts, echoMessageId } from "@zvada/agent-server/protocol/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionFold,
  createStreamCursor,
  flushDeltas,
  messagesKey,
  routeEnvelope,
  type AgentStreamContext,
  type SessionFold,
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
  fold: (sessionId?: string) => SessionFold;
  /** Apply whatever the deltas marked dirty, as the animation frame would. */
  flush: (sessionId?: string) => void;
}

function harness(activeSessionId = SESSION): Harness {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scheduleFlush = vi.fn();
  const requestRefetch = vi.fn();
  const ctx: AgentStreamContext = {
    queryClient: qc,
    activeSessionId,
    folds: new Map(),
    cursor: createStreamCursor(),
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
    fold(sessionId = activeSessionId) {
      return ctx.folds.get(sessionId) ?? createSessionFold();
    },
    flush(sessionId = activeSessionId) {
      flushDeltas(qc, sessionId, this.fold(sessionId));
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
    outputIndex: 1,
    partIndex: 0,
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
// Parts: what a part-upserted change writes
// ===========================================================================

describe("message.part — the row write", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.feed(started());
  });

  it("appends a new part and replaces an existing one in place", () => {
    h.feed(partEvent(textPart("p1", "one")));
    h.feed(partEvent(textPart("p2", "two"), { partIndex: 1 }));
    h.feed(partEvent(textPart("p1", "one (final)", { state: "done" })));

    const parts = h.page()!.messages[0].parts!;
    expect(parts.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect((parts[0] as { text: string }).text).toBe("one (final)");
  });

  it("shells in a row for a part whose message.started was never seen", () => {
    // The contract's stated exception (a part may outrun its message), which
    // the reducer handles by opening a shell and reporting message-upserted
    // BEFORE the part. The old hand-rolled fold dropped such parts on the
    // floor, so a transcript joined mid-message rendered a hole.
    h.feed(partEvent(textPart("ghost", "x", { messageId: "nope" }), { messageId: "nope" }));

    const byId = new Map(h.page()!.messages.map((m) => [m.id, m]));
    expect([...byId.keys()]).toEqual(["a1", "nope"]);
    expect(byId.get("nope")!.parts!.map((p) => p.id)).toEqual(["ghost"]);
    expect(byId.get("nope")!.role).toBe("assistant");
  });
});

// ===========================================================================
// Deltas: the reducer accumulates, the frame flush projects
// ===========================================================================

describe("message.part.delta — batched to the frame", () => {
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

  it("does not write the cache until the frame runs", () => {
    h.feed(delta("p1", "A"));
    expect(text(h)).toBe("");
    h.flush();
    expect(text(h)).toBe("A");
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

  it("streamed tool input is kept in the fold, not written per delta", () => {
    h.feed({
      type: "message.part.delta",
      sessionId: SESSION,
      turnId: TURN,
      messageId: "a1",
      partId: "t1",
      outputIndex: 1,
      partIndex: 1,
      delta: { type: "tool_input", input: '{"pa' },
      timestamp: T,
    } as LifecycleEvent);

    expect(h.fold().state.toolInputJson.t1).toBe('{"pa');
    // A delta-buffered change is not a row: nothing was written, nothing dirty.
    expect(h.fold().dirtyMessages.size).toBe(0);
  });
});

// ===========================================================================
// C2: the composer PREDICTS the echo instead of reconciling it
// ===========================================================================

describe("message.started{role:user} — the predicted echo", () => {
  const echoStarted = (turnId = TURN) =>
    started({ messageId: echoMessageId(turnId), role: "user", outputIndex: 0, turnId });

  it("upserts onto the composer's bubble — one row, same id, no swap", () => {
    const h = harness();
    const bubble = createOptimisticUserMessage({
      sessionId: SESSION,
      turnId: TURN,
      content: "what is 2+2?",
    });
    seed(h.qc, SESSION, [bubble]);

    h.feed(echoStarted());

    const messages = h.page()!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(echoMessageId(TURN));
    expect(messages[0].turn_id).toBe(TURN);
    // The typed text keeps rendering — the bubble was never replaced by a
    // parts-less row while the echo's own parts were still in flight.
    expect(messages[0].parts).toEqual(bubble.parts);
  });

  it("the engine's echo parts land on the predicted ones — byte for byte", () => {
    const h = harness();
    const input = [
      { type: "text" as const, text: "review this" },
      { type: "file" as const, data: "AAAA", mimeType: "application/pdf", filename: "spec.pdf" },
    ];
    const bubble = createOptimisticUserMessage({
      sessionId: SESSION,
      turnId: TURN,
      content: JSON.stringify(input),
    });
    seed(h.qc, SESSION, [bubble]);

    h.feed(echoStarted());
    // What the engine actually emits for this turn, part by part.
    createUserEchoParts(input, TURN).forEach((part, index) => {
      h.feed(
        partEvent({ ...part, sessionId: SESSION, messageId: echoMessageId(TURN) } as Part, {
          messageId: echoMessageId(TURN),
          outputIndex: 0,
          partIndex: index,
        })
      );
    });

    const messages = h.page()!.messages;
    expect(messages).toHaveLength(1);
    // Two parts, not four: the prediction and the echo are the same ids. The
    // file part survives — the swap-a-look-alike bubble dropped it.
    expect(messages[0].parts!.map((p) => p.type)).toEqual(["text", "file"]);
    expect(messages[0].parts!.map((p) => p.id)).toEqual(bubble.parts!.map((p) => p.id));
  });

  it("a different turn's echo appends instead of eating the bubble", () => {
    const h = harness();
    const bubble = createOptimisticUserMessage({
      sessionId: SESSION,
      turnId: "some-other-turn",
      content: "still mine",
    });
    seed(h.qc, SESSION, [bubble]);

    h.feed(echoStarted());

    expect(h.page()!.messages.map((m) => m.id)).toEqual([bubble.id, echoMessageId(TURN)]);
  });

  it("an echo that already landed via q:delta does not leave a duplicate", () => {
    const h = harness();
    // The backend invalidates BEFORE it pushes the envelope, so the persisted
    // row often arrives first — under the same id, so it IS the same row.
    seed(h.qc, SESSION, [
      {
        id: echoMessageId(TURN),
        session_id: SESSION,
        seq: 4,
        role: "user",
        turn_id: TURN,
        parts: [],
      },
    ]);

    h.feed(echoStarted());

    expect(h.page()!.messages.map((m) => m.id)).toEqual([echoMessageId(TURN)]);
    // SQLite owns `seq`; the stream knows nothing about it and must not zero it.
    expect(h.page()!.messages[0].seq).toBe(4);
  });

  it("a shelled-in message never nulls out what the DB snapshot already knew", () => {
    // A part can outrun its `message.started` (or deus can attach mid-message):
    // the fold opens a shell that knows no model and no parent tool call, and
    // writing those as null would erase the persisted row's own values.
    const h = harness();
    seed(h.qc, SESSION, [
      {
        id: "a1",
        session_id: SESSION,
        seq: 3,
        role: "assistant",
        turn_id: TURN,
        model: "claude-opus-5",
        parent_tool_call_id: "task-1",
        parts: [],
      },
    ]);

    h.feed(partEvent(textPart("p1", "late")));

    expect(h.page()!.messages[0]).toMatchObject({
      model: "claude-opus-5",
      parent_tool_call_id: "task-1",
    });
  });

  it("seeds a page for the active session when events beat the first fetch", () => {
    const h = harness();
    h.feed(started());
    expect(h.page()!.messages.map((m) => m.id)).toEqual(["a1"]);
  });
});

// ===========================================================================
// I3: routing a stream the browser cannot replay
// ===========================================================================

describe("routeEnvelope — cursor policy", () => {
  it("joins mid-stream without calling the first envelope a gap", () => {
    // Deus attaches to a turn already in flight: the page came from SQLite and
    // the socket from wherever the engine is now. Reporting a hole here would
    // refetch the page deus just fetched, on every session.
    const h = harness();
    h.feed(started(), { seq: 42 });

    expect(h.requestRefetch).not.toHaveBeenCalled();
    expect(h.page()!.messages.map((m) => m.id)).toEqual(["a1"]);
  });

  it("asks for exactly one refetch per gap, folds the event, and keeps counting", () => {
    const h = harness();
    h.feed(started(), { seq: 1 });
    h.feed(partEvent(textPart("p1", "kept")), { seq: 9 });

    expect(h.requestRefetch).toHaveBeenCalledTimes(1);
    expect(h.requestRefetch).toHaveBeenCalledWith(SESSION);
    expect(h.page()!.messages[0].parts).toHaveLength(1);

    // The hole was accepted as lost, so the stream continues normally rather
    // than reporting every following envelope as another gap.
    h.feed(partEvent(textPart("p2", "next"), { partIndex: 1 }), { seq: 10 });
    expect(h.requestRefetch).toHaveBeenCalledTimes(1);
  });

  it("drops a duplicate envelope entirely — no fold, no refetch", () => {
    const h = harness();
    h.feed(started(), { seq: 1 });
    h.feed(partEvent(textPart("p1", "")), { seq: 2 });
    h.feed(delta("p1", "A"), { seq: 2 });
    h.flush();

    expect((h.page()!.messages[0].parts![0] as { text: string }).text).toBe("");
    expect(h.requestRefetch).not.toHaveBeenCalled();
  });

  it("drops the folded state when the log restarts at 1", () => {
    const h = harness();
    h.feed(started(), { seq: 1 });
    h.feed(partEvent(textPart("p1", "before")), { seq: 2 });
    expect(h.fold().state.timeline).toHaveLength(1);

    // The agent-server was replaced: the session log begins again.
    h.feed(started({ messageId: "a2" }), { seq: 1 });

    expect(h.requestRefetch).toHaveBeenCalledWith(SESSION);
    // Nothing from the dead log survives in the fold — it would otherwise
    // shadow the new log's own messages by id forever.
    expect(h.fold().state.timeline.map((e) => e.kind === "message" && e.messageId)).toEqual(["a2"]);
  });

  it("treats a mid-stream backwards seq as a log replacement, not a duplicate", () => {
    // The engine cursor only recognizes a restart seen FROM seq 1. If this
    // client's reconnect overlapped the restart (or a restarted backend
    // re-forwards from a healed log), its first sight of the new log is some
    // seq far below the dead watermark — reading that as "duplicate" would
    // silently drop every envelope until the new counter caught up.
    const h = harness();
    h.feed(started(), { seq: 41 });
    h.feed(partEvent(textPart("p1", "old")), { seq: 42 });
    expect(h.requestRefetch).not.toHaveBeenCalled();

    h.feed(started({ messageId: "a2" }), { seq: 5 });

    expect(h.requestRefetch).toHaveBeenCalledWith(SESSION);
    // The dead log's fold is gone; the new log's message is the only one.
    expect(h.fold().state.timeline.map((e) => e.kind === "message" && e.messageId)).toEqual(["a2"]);

    // And the stream keeps counting from the replacement.
    h.feed(partEvent(textPart("p2", "new", { messageId: "a2" })), { seq: 6 });
    expect(h.requestRefetch).toHaveBeenCalledTimes(1);

    // The immediately-last frame is still an ordinary duplicate.
    h.feed(partEvent(textPart("p2", "new", { messageId: "a2" })), { seq: 6 });
    expect(h.requestRefetch).toHaveBeenCalledTimes(1);
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

  it("tracks each session's stream separately", () => {
    const h = harness(SESSION);
    seed(h.qc, OTHER, []);
    h.feed(started(), { seq: 7 });
    h.feed(started({ sessionId: OTHER, messageId: "b1" }), { sessionId: OTHER, seq: 1 });
    h.feed(partEvent(textPart("p1", "x")), { seq: 8 });

    expect(h.requestRefetch).not.toHaveBeenCalled();
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

  it("I5: a cancel before the first assistant message still leaves a marker — the backend's row", () => {
    // The marker is minted from `shared/conversation-rows.ts`, the same
    // function the backend INSERTs, so the mirrored row and the persisted one
    // are the SAME row: same derived id, same accounting. Tokens and cost used
    // to be dropped here, which meant the q:delta carrying the persisted copy
    // silently changed the divider's footer on arrival.
    const h = harness();
    h.feed(started({ messageId: "u1", role: "user", outputIndex: 0 }));
    h.feed(
      turnEnded({
        stopReason: "cancelled",
        tokens: { input: 9, output: 1 },
        cost: 0.02,
        timestamp: T + 5,
      })
    );

    const marker = h.page()!.messages[1];
    expect(marker).toMatchObject({
      id: `cancelled-${TURN}`,
      role: "assistant",
      turn_id: TURN,
      turn_stop_reason: "cancelled",
      cancelled_at: new Date(T + 5).toISOString(),
      sent_at: new Date(T + 5).toISOString(),
      tokens: JSON.stringify({ input: 9, output: 1 }),
      cost: 0.02,
    });
    expect(marker.parts).toEqual([]);
  });

  it("a clean turn with no assistant message adds nothing", () => {
    const h = harness();
    h.feed(started({ messageId: "u1", role: "user", outputIndex: 0 }));
    h.feed(turnEnded({ stopReason: "end_turn" }));

    expect(h.page()!.messages).toHaveLength(1);
  });

  it("turn.started alone mirrors nothing — there is no accounting yet", () => {
    const h = harness();
    h.feed(started({ messageId: "a1" }));
    h.feed({
      type: "turn.started",
      sessionId: SESSION,
      turnId: TURN,
      timestamp: T,
    } as LifecycleEvent);

    expect(h.page()!.messages[0].turn_stop_reason).toBeUndefined();
  });

  it("a cancelled turn closes its open tool parts in the cache too", () => {
    const h = harness();
    h.feed(started({ messageId: "a1" }));
    h.feed(
      partEvent({
        type: "tool",
        id: "t1",
        sessionId: SESSION,
        messageId: "a1",
        toolCallId: "call-1",
        toolName: "Bash",
        state: { status: "in_progress", input: {}, time: { start: T } },
      } as unknown as Part)
    );

    h.feed(turnEnded({ stopReason: "cancelled", timestamp: T + 5 }));

    const part = h.page()!.messages[0].parts![0] as { state: { status: string } };
    expect(part.state.status).toBe("cancelled");
  });
});

// ===========================================================================
// I4: sessions the user is not looking at
// ===========================================================================

describe("mid-stream attach — the fold is a fragment, the page is the truth", () => {
  it("merges the fold's parts into the cached row by id instead of replacing them", () => {
    // Opening a session mid-turn: the page came from SQLite with the turn's
    // earlier parts; the fold has only seen the stream from the attach point.
    // A wholesale `parts` write from that fragment would erase p1/p2.
    const h = harness();
    seed(h.qc, SESSION, [
      {
        id: "a1",
        session_id: SESSION,
        seq: 7,
        role: "assistant",
        turn_id: TURN,
        sent_at: new Date(T).toISOString(),
        parts: [textPart("p1", "from the db"), textPart("p2", "also db")],
      } as Message,
    ]);

    h.feed(partEvent(textPart("p3", "live"), { partIndex: 2 }), { seq: 42 });

    const parts = h.page()!.messages[0].parts!;
    expect(parts.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect((parts[2] as { text: string }).text).toBe("live");

    // And a re-stated part the fold DOES know replaces in place, not appends.
    h.feed(partEvent(textPart("p3", "live (final)"), { partIndex: 2 }), { seq: 43 });
    expect(h.page()!.messages[0].parts!.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect((h.page()!.messages[0].parts![2] as { text: string }).text).toBe("live (final)");
  });
});

describe("background sessions", () => {
  it("delivers turn accounting to a session whose panel is not mounted", () => {
    // Active session is SESSION; the turn that ends belongs to OTHER, whose
    // page is cached from an earlier visit. The `messages` subscription is
    // delta-only, so an UPDATE has no other way in.
    const h = harness(SESSION);
    seed(h.qc, OTHER, [{ id: "b1", session_id: OTHER, seq: 1, role: "assistant", turn_id: TURN }]);

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

  it("never invents a page — or a fold — for a session that was never opened", () => {
    const h = harness(SESSION);

    h.feed(started({ sessionId: OTHER, messageId: "b1" }), { sessionId: OTHER });

    expect(h.page(OTHER)).toBeUndefined();
    // Not folding it is what keeps the memory cost bounded by the pages the
    // cache already holds, rather than by every session on the socket.
    expect(h.ctx.folds.has(OTHER)).toBe(false);
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

    h.feed(
      {
        ...(delta("bp1", "ignored") as object),
        sessionId: OTHER,
        messageId: "b1",
      } as LifecycleEvent,
      { sessionId: OTHER }
    );
    h.flush(OTHER);

    expect((h.page(OTHER)!.messages[0].parts![0] as { text: string }).text).toBe("snap");
    expect(h.scheduleFlush).not.toHaveBeenCalled();
  });
});
