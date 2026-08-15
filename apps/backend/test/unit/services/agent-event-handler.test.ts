// The backend consumes the @zvada/agent-server lifecycle stream natively: the
// engine's fold says what moved, `persistChanges` writes the rows. These tests
// pin what is left for the HANDLER to decide — which pushes go out, which
// resources each change kind invalidates, the turn admission mirror and the
// error dedupe. The rows themselves (and the fold that produces them) are
// covered against a real database in agent-persistence.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationState,
  ConversationTurn,
  LifecycleEvent,
  MessageStartedEvent,
  TurnEndedEvent,
  WireEventEnvelope,
} from "@zvada/agent-server/protocol";
import type { ChangeWrite, TurnOutcomeWrite } from "../../../src/services/agent/persistence";

// ============================================================================
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ============================================================================

const {
  mockPersistAgentSessionId,
  mockPersistChanges,
  mockPersistSessionError,
  mockPersistSessionTitle,
  mockInvalidate,
  mockBroadcast,
  mockRefreshPr,
  outcomes,
} = vi.hoisted(() => ({
  mockPersistAgentSessionId: vi.fn<(...args: any[]) => any>(() => ({ ok: true, value: undefined })),
  mockPersistChanges: vi.fn<(...args: any[]) => any>(),
  mockPersistSessionError: vi.fn<(...args: any[]) => any>(() => ({ ok: true, value: undefined })),
  mockPersistSessionTitle: vi.fn<(...args: any[]) => any>(() => ({ ok: true, value: undefined })),
  mockInvalidate: vi.fn<(...args: any[]) => any>(),
  mockBroadcast: vi.fn<(...args: any[]) => any>(),
  mockRefreshPr: vi.fn<(...args: any[]) => any>(),
  outcomes: [] as Array<{ turn: ConversationTurn; outcome: TurnOutcomeWrite }>,
}));

vi.mock("../../../src/services/agent/persistence", () => ({
  persistAgentSessionId: mockPersistAgentSessionId,
  persistChanges: mockPersistChanges,
  persistSessionError: mockPersistSessionError,
  persistSessionTitle: mockPersistSessionTitle,
}));

vi.mock("../../../src/services/query-engine", () => ({ invalidate: mockInvalidate }));
vi.mock("../../../src/services/ws.service", () => ({ broadcast: mockBroadcast }));
vi.mock("../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: mockRefreshPr,
}));

/**
 * A `persistChanges` that writes nothing and reports everything as written.
 *
 * It still calls `outcomeFor` for an ended turn, because deciding the outcome
 * is what advances the handler's dedupe flag — the ONE piece of session state
 * that lives on the write path rather than beside it.
 */
function stubPersistChanges(
  _sessionId: string,
  state: ConversationState,
  changes: Array<{ kind: ChangeWrite["kind"]; turnId?: string }>,
  outcomeFor: (turn: ConversationTurn) => TurnOutcomeWrite
): ChangeWrite[] {
  const writes: ChangeWrite[] = [];
  for (const change of changes) {
    if (change.kind === "turn-updated") {
      const turn = state.turns.find((t) => t.turnId === change.turnId);
      if (!turn || turn.status !== "ended") continue;
      outcomes.push({ turn, outcome: outcomeFor(turn) });
    }
    if (change.kind === "usage-updated" && !state.usage) continue;
    writes.push({ kind: change.kind, detail: "", result: { ok: true, value: null } });
  }
  return writes;
}

/** The outcome the handler decided for the turn that just ended. */
function lastOutcome(turnId = TURN): TurnOutcomeWrite | undefined {
  return outcomes.filter((o) => o.turn.turnId === turnId).at(-1)?.outcome;
}

/** Which resources the handler invalidated, flattened and deduplicated. */
function invalidated(): string[] {
  return [...new Set(mockInvalidate.mock.calls.flatMap(([resources]) => resources as string[]))];
}

// ============================================================================
// Import after mocks
// ============================================================================

import { createAgentEventHandler } from "../../../src/services/agent/event-handler";

const SESSION = "sess-1";
const TURN = "turn-1";
const T = 1_700_000_000_000;

let seq = 0;
function envelope(event: LifecycleEvent): WireEventEnvelope {
  return { sessionId: SESSION, seq: ++seq, event };
}

function messageStarted(over: Partial<MessageStartedEvent> = {}): MessageStartedEvent {
  return {
    type: "message.started",
    sessionId: SESSION,
    turnId: TURN,
    messageId: "msg-1",
    outputIndex: 1,
    role: "assistant",
    timestamp: T,
    ...over,
  };
}

function turnEnded(over: Partial<TurnEndedEvent> = {}): TurnEndedEvent {
  return {
    type: "turn.ended",
    sessionId: SESSION,
    turnId: TURN,
    stopReason: "end_turn",
    timestamp: T,
    ...over,
  };
}

const partEvent: LifecycleEvent = {
  type: "message.part",
  sessionId: SESSION,
  turnId: TURN,
  messageId: "msg-1",
  outputIndex: 1,
  partIndex: 0,
  part: {
    type: "text",
    id: "part-1",
    sessionId: SESSION,
    messageId: "msg-1",
    text: "hello",
    state: "done",
  },
  timestamp: T,
};

/** Every agent:event frame the handler pushed, decoded. */
function pushedEnvelopes(): WireEventEnvelope[] {
  return mockBroadcast.mock.calls
    .map(([raw]) => JSON.parse(raw as unknown as string))
    .filter((frame) => frame.event === "agent:event")
    .map((frame) => frame.data as WireEventEnvelope);
}

describe("agent event handler (canonical lifecycle stream)", () => {
  let handler: ReturnType<typeof createAgentEventHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    outcomes.length = 0;
    mockPersistChanges.mockImplementation(stubPersistChanges as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    handler = createAgentEventHandler();
  });

  // ==========================================================================
  // session.created
  // ==========================================================================

  describe("session.created", () => {
    const created = (resumed?: boolean): LifecycleEvent => ({
      type: "session.created",
      sessionId: SESSION,
      nativeSessionId: "native-abc",
      harness: "claude-code",
      timestamp: T,
      ...(resumed !== undefined ? { resumed } : {}),
    });

    it("persists the native session id for resume and invalidates the session", () => {
      handler.handle(envelope(created()));

      expect(mockPersistAgentSessionId).toHaveBeenCalledWith(SESSION, "native-abc");
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: [SESSION],
      });
    });

    it("warns when the harness did NOT resume (context silently lost)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      handler.handle(envelope(created(false)));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("did NOT resume"));
      // The flag reaches the UI too — the envelope is pushed verbatim.
      expect(pushedEnvelopes().at(-1)?.event).toMatchObject({ resumed: false });
    });

    it("does not warn on a successful resume", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      handler.handle(envelope(created(true)));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // message.started — the user echo IS the persistence path
  // ==========================================================================

  describe("message.started", () => {
    it("folds the engine's user echo into a message row and invalidates the page", () => {
      const echo = messageStarted({ role: "user", outputIndex: 0, messageId: "user-msg" });

      handler.handle(envelope(echo));

      const [, state, changes] = mockPersistChanges.mock.calls[0];
      expect(changes).toEqual([{ kind: "message-upserted", messageId: "user-msg", turnId: TURN }]);
      expect((state as ConversationState).timeline[0]).toMatchObject({
        messageId: "user-msg",
        role: "user",
        turnId: TURN,
      });
      expect(mockInvalidate).toHaveBeenCalledWith(["messages", "session"], {
        sessionIds: [SESSION],
      });
    });

    it("carries turn, parent tool call and model into the folded message", () => {
      handler.handle(
        envelope(messageStarted({ parentToolCallId: "tool-7", model: "claude-opus-5" }))
      );

      const [, state] = mockPersistChanges.mock.calls[0];
      expect((state as ConversationState).timeline[0]).toMatchObject({
        turnId: TURN,
        parentToolCallId: "tool-7",
        model: "claude-opus-5",
      });
      expect(pushedEnvelopes().at(-1)?.event).toMatchObject({ type: "message.started" });
    });

    it("skips invalidation when the write failed", () => {
      mockPersistChanges.mockReturnValueOnce([
        { kind: "message-upserted", detail: "", result: { ok: false, error: "no session" } },
      ] as never);

      handler.handle(envelope(messageStarted()));

      expect(mockInvalidate).not.toHaveBeenCalled();
      // The push still happens: live rendering must not depend on the write.
      expect(pushedEnvelopes()).toHaveLength(1);
    });

    it("reports only the part when its message is already known, and does not re-invalidate", () => {
      // The page is not stale for a part: the frontend already has it from the
      // pushed envelope, so a q:delta would only run a wasted query.
      handler.handle(envelope(messageStarted()));
      mockInvalidate.mockClear();

      handler.handle(envelope(partEvent));

      expect(mockPersistChanges.mock.calls.at(-1)![2]).toEqual([
        {
          kind: "part-upserted",
          messageId: "msg-1",
          partId: "part-1",
          outputIndex: 1,
          partIndex: 0,
        },
      ]);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // parts
  // ==========================================================================

  describe("message.part / message.part.delta", () => {
    it("shells in the message a part outran, then writes the part", () => {
      handler.handle(envelope(partEvent));

      expect(mockPersistChanges.mock.calls[0][2]).toEqual([
        { kind: "message-upserted", messageId: "msg-1", turnId: TURN },
        {
          kind: "part-upserted",
          messageId: "msg-1",
          partId: "part-1",
          outputIndex: 1,
          partIndex: 0,
        },
      ]);
      expect(pushedEnvelopes()).toHaveLength(1);
    });

    it("forwards deltas without touching the database", () => {
      handler.handle(
        envelope({
          type: "message.part.delta",
          sessionId: SESSION,
          turnId: TURN,
          messageId: "msg-1",
          outputIndex: 1,
          partIndex: 0,
          partId: "part-1",
          delta: { type: "text", text: "he" },
          timestamp: T,
        })
      );

      // Deltas are forward-only (spec 04 §C2): the fold keeps them current in
      // state, but persistence is skipped wholesale — a part-row write per
      // token would be quadratic on the WS hot path, for durability the
      // protocol does not promise. The settling message.part snapshot writes.
      expect(mockPersistChanges).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
      expect(pushedEnvelopes()).toHaveLength(1);
    });
  });

  // ==========================================================================
  // turn.ended
  // ==========================================================================

  describe("turn.ended", () => {
    it("carries tokens and cost into the folded turn, and refreshes the PR snapshot", () => {
      handler.handle(
        envelope(
          turnEnded({
            tokens: { input: 100, output: 20, cache: { read: 5, write: 0 } },
            cost: 0.0123,
          })
        )
      );

      const [, state] = mockPersistChanges.mock.calls[0];
      expect((state as ConversationState).turns[0]).toMatchObject({
        turnId: TURN,
        status: "ended",
        tokens: { input: 100, output: 20, cache: { read: 5, write: 0 } },
        cost: 0.0123,
      });
      expect(lastOutcome()).toEqual({ status: "idle", cancelled: false });
      expect(mockRefreshPr).toHaveBeenCalledWith(SESSION);
    });

    it("marks a cancelled turn instead of inserting a synthetic message", () => {
      handler.handle(envelope(turnEnded({ stopReason: "cancelled" })));

      expect(lastOutcome()).toEqual({ status: "idle", cancelled: true });
    });

    it.each(["refusal", "max_turn_requests"])(
      "leaves the session idle and persists the %s outcome",
      (stopReason) => {
        handler.handle(envelope(turnEnded({ stopReason })));

        expect(lastOutcome()).toEqual({ status: "idle", cancelled: false });
      }
    );

    it("takes the error message and category from ErrorInfo", () => {
      handler.handle(
        envelope(
          turnEnded({
            stopReason: "error",
            error: { category: "rate_limit", message: "429 slow down" },
          })
        )
      );

      expect(lastOutcome()).toEqual({
        status: "error",
        cancelled: false,
        error: { message: "429 slow down", category: "rate_limit" },
      });
    });

    it("classifies the message when the engine reported no ErrorInfo", () => {
      handler.handle(envelope(turnEnded({ stopReason: "error" })));

      expect(lastOutcome()).toEqual({
        status: "error",
        cancelled: false,
        error: { message: "Agent turn failed", category: "internal" },
      });
    });

    it("does not re-report an error a standalone error event already wrote", () => {
      handler.handle(
        envelope({
          type: "error",
          sessionId: SESSION,
          turnId: TURN,
          category: "auth",
          message: "not logged in",
          recoverable: false,
          timestamp: T,
        })
      );
      expect(mockPersistSessionError).toHaveBeenCalledWith(SESSION, "not logged in", "auth");

      handler.handle(envelope(turnEnded({ stopReason: "error" })));

      // Status still error, but the vaguer terminal message must not clobber
      // the specific one already persisted.
      expect(lastOutcome()).toEqual({ status: "error", cancelled: false });
    });

    it("a replayed turn.ended folds to nothing, so nothing is written twice", () => {
      const event = turnEnded({ stopReason: "cancelled" });
      handler.handle(envelope(event));
      handler.handle({ sessionId: SESSION, seq: 99, event });

      expect(mockPersistChanges.mock.calls.at(-1)![2]).toEqual([]);
      expect(outcomes).toHaveLength(1);
    });
  });

  // ==========================================================================
  // session.usage / compaction / errors
  // ==========================================================================

  describe("session.usage", () => {
    it("persists the gauge and invalidates the session (no push)", () => {
      const event: LifecycleEvent = {
        type: "session.usage",
        sessionId: SESSION,
        turnId: TURN,
        used: 1234,
        size: 200_000,
        timestamp: T,
      };

      handler.handle(envelope(event));

      const [, state, changes] = mockPersistChanges.mock.calls[0];
      expect(changes).toEqual([{ kind: "usage-updated" }]);
      expect((state as ConversationState).usage).toMatchObject({ used: 1234, size: 200_000 });
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: [SESSION],
      });
      expect(pushedEnvelopes()).toHaveLength(0);
    });

    it("the fold makes the window size sticky when the harness stops reporting it", () => {
      handler.handle(
        envelope({
          type: "session.usage",
          sessionId: SESSION,
          turnId: TURN,
          used: 1000,
          size: 200_000,
          timestamp: T,
        })
      );
      handler.handle(
        envelope({
          type: "session.usage",
          sessionId: SESSION,
          turnId: TURN,
          used: 1200,
          timestamp: T + 1,
        })
      );

      const [, state] = mockPersistChanges.mock.calls.at(-1)!;
      expect((state as ConversationState).usage).toMatchObject({ used: 1200, size: 200_000 });
    });
  });

  describe("session.compaction", () => {
    it("persists the marker row and pushes it", () => {
      const event: LifecycleEvent = {
        type: "session.compaction",
        sessionId: SESSION,
        turnId: TURN,
        compactionId: "cmp-1",
        status: "completed",
        trigger: "auto",
        preTokens: 180_000,
        postTokens: 20_000,
        timestamp: T,
      };

      handler.handle(envelope(event));

      const [, state, changes] = mockPersistChanges.mock.calls[0];
      expect(changes).toEqual([{ kind: "compaction-upserted", compactionId: "cmp-1" }]);
      expect((state as ConversationState).timeline[0]).toMatchObject({
        kind: "compaction",
        compactionId: "cmp-1",
        status: "completed",
      });
      expect(mockInvalidate).toHaveBeenCalledWith(["messages", "session"], {
        sessionIds: [SESSION],
      });
      expect(pushedEnvelopes()).toHaveLength(1);
    });
  });

  describe("error", () => {
    it("swallows recoverable errors — the turn is still running", () => {
      handler.handle(
        envelope({
          type: "error",
          sessionId: SESSION,
          turnId: TURN,
          category: "rate_limit",
          message: "backing off",
          recoverable: true,
          timestamp: T,
        })
      );

      expect(mockPersistSessionError).not.toHaveBeenCalled();
      expect(invalidated()).toEqual([]);
      // Still forwarded as a diagnostic.
      expect(pushedEnvelopes()).toHaveLength(1);
    });

    it("keeps a swallowed recoverable error from suppressing the real one", () => {
      handler.handle(
        envelope({
          type: "error",
          sessionId: SESSION,
          turnId: TURN,
          category: "network",
          message: "retrying",
          recoverable: true,
          timestamp: T,
        })
      );
      handler.handle(envelope(turnEnded({ stopReason: "error" })));

      expect(lastOutcome()).toEqual({
        status: "error",
        cancelled: false,
        error: { message: "Agent turn failed", category: "internal" },
      });
    });
  });

  // ==========================================================================
  // Turn admission mirror
  // ==========================================================================

  describe("turn admission mirror", () => {
    it("refuses a second turn while one is live, and frees it at turn.ended", () => {
      expect(handler.beginTurn(SESSION, TURN)).toBe(true);
      expect(handler.beginTurn(SESSION, "turn-2")).toBe(false);

      handler.handle(envelope(turnEnded()));

      expect(handler.beginTurn(SESSION, "turn-2")).toBe(true);
    });

    it("force-registers when the server accepted a turn we thought was busy", () => {
      handler.beginTurn(SESSION, TURN);
      expect(handler.beginTurn(SESSION, "turn-2", { force: true })).toBe(true);
    });

    it("rolls back only its own rejected admission", () => {
      handler.beginTurn(SESSION, TURN);
      handler.abortTurn(SESSION, "someone-else");
      expect(handler.beginTurn(SESSION, "turn-2")).toBe(false);

      handler.abortTurn(SESSION, TURN);
      expect(handler.beginTurn(SESSION, "turn-2")).toBe(true);
    });
  });

  // ==========================================================================
  // Coverage of the full union
  // ==========================================================================

  it("handles every lifecycle event type without throwing", () => {
    const events: LifecycleEvent[] = [
      {
        type: "session.created",
        sessionId: SESSION,
        nativeSessionId: "n",
        harness: "claude-code",
        timestamp: T,
      },
      { type: "session.ended", sessionId: SESSION, reason: "idle", timestamp: T },
      { type: "turn.started", sessionId: SESSION, turnId: TURN, timestamp: T },
      messageStarted(),
      {
        type: "message.part",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "msg-1",
        outputIndex: 1,
        partIndex: 0,
        part: {
          type: "text",
          id: "p",
          sessionId: SESSION,
          messageId: "msg-1",
          text: "x",
        },
        timestamp: T,
      },
      {
        type: "message.part.delta",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "msg-1",
        outputIndex: 1,
        partIndex: 0,
        partId: "p",
        delta: { type: "text", text: "x" },
        timestamp: T,
      },
      { type: "message.ended", sessionId: SESSION, turnId: TURN, messageId: "msg-1", timestamp: T },
      turnEnded(),
      { type: "session.usage", sessionId: SESSION, turnId: TURN, used: 1, timestamp: T },
      {
        type: "session.compaction",
        sessionId: SESSION,
        turnId: TURN,
        compactionId: "c",
        status: "completed",
        timestamp: T,
      },
      {
        type: "permission.requested",
        sessionId: SESSION,
        turnId: TURN,
        requestId: "r",
        title: "Allow?",
        options: [],
        timestamp: T,
      },
      {
        type: "permission.resolved",
        sessionId: SESSION,
        turnId: TURN,
        requestId: "r",
        outcome: { outcome: "cancelled" },
        timestamp: T,
      },
      {
        type: "error",
        sessionId: SESSION,
        category: "internal",
        message: "boom",
        recoverable: false,
        timestamp: T,
      },
      {
        type: "raw",
        sessionId: SESSION,
        turnId: TURN,
        harness: "claude-code",
        data: {},
        timestamp: T,
      },
    ];

    for (const event of events) {
      expect(() => handler.handle(envelope(event))).not.toThrow();
    }
  });

  // ==========================================================================
  // Law 6 — tolerant of the unknown
  // ==========================================================================

  describe("an event type this build does not know", () => {
    // The wire decoder preserves it; `.exhaustive()` alone would THROW on it,
    // which is a crash per envelope the day the engine adds a member.
    const future = {
      type: "session.checkpoint",
      sessionId: SESSION,
      raw: { type: "session.checkpoint", sessionId: SESSION, checkpointId: "c1" },
    } as unknown as LifecycleEvent;

    it("forwards it verbatim instead of throwing or dropping it", () => {
      expect(() => handler.handle(envelope(future))).not.toThrow();

      expect(pushedEnvelopes().map((e) => e.event.type)).toEqual(["session.checkpoint"]);
    });

    it("persists nothing — there are no columns for a shape it cannot read", () => {
      handler.handle(envelope(future));

      expect(mockPersistChanges).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Per-turn state
  // ==========================================================================

  describe("session state", () => {
    it("turn.started clears the previous turn's error-dedupe flag", () => {
      // A turn deus did not admit via beginTurn (replay, engine-initiated)
      // would otherwise inherit `errorReported` and have its terminal error
      // silently downgraded to "already reported".
      handler.handle(
        envelope({
          type: "error",
          sessionId: SESSION,
          turnId: TURN,
          category: "auth",
          message: "not logged in",
          recoverable: false,
          timestamp: T,
        })
      );
      handler.handle(
        envelope({ type: "turn.started", sessionId: SESSION, turnId: "turn-2", timestamp: T })
      );
      handler.handle(envelope(turnEnded({ turnId: "turn-2", stopReason: "error" })));

      expect(lastOutcome("turn-2")).toMatchObject({
        status: "error",
        error: { message: "Agent turn failed" },
      });
    });

    it("session.ended drops the session's entry — the map is otherwise unbounded", () => {
      handler.handle(
        envelope({ type: "turn.started", sessionId: SESSION, turnId: TURN, timestamp: T })
      );
      handler.handle(
        envelope({ type: "session.ended", sessionId: SESSION, reason: "idle", timestamp: T })
      );

      // A fresh entry means the old one is gone: beginTurn only refuses when a
      // live turn is still registered.
      expect(handler.beginTurn(SESSION, "turn-3")).toBe(true);
    });
  });

  // ==========================================================================
  // Side channel
  // ==========================================================================

  describe("handleTitle", () => {
    it("persists the title and invalidates the session resources", () => {
      handler.handleTitle(SESSION, "Fix the login bug");

      expect(mockPersistSessionTitle).toHaveBeenCalledWith(SESSION, "Fix the login bug");
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: [SESSION],
      });
    });
  });
});
