// The backend consumes the @zvada/agent-server lifecycle stream natively:
// these tests pin the persistence + push decisions per engine event, with the
// persistence layer mocked (agent-persistence.test.ts covers the SQL).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LifecycleEvent,
  MessageStartedEvent,
  TurnEndedEvent,
  WireEventEnvelope,
} from "@zvada/agent-server/protocol";

// ============================================================================
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ============================================================================

const {
  mockPersistAgentSessionId,
  mockPersistCompaction,
  mockPersistMessageStarted,
  mockPersistPart,
  mockPersistSessionError,
  mockPersistSessionTitle,
  mockPersistSessionUsage,
  mockPersistTurnEnded,
  mockInvalidate,
  mockBroadcast,
  mockRefreshPr,
} = vi.hoisted(() => ({
  mockPersistAgentSessionId: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistCompaction: vi.fn(() => ({ ok: true, value: "cmp-1" })),
  mockPersistMessageStarted: vi.fn(() => ({ ok: true, value: "msg-1" })),
  mockPersistPart: vi.fn(() => ({ ok: true, value: "part-1" })),
  mockPersistSessionError: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionTitle: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionUsage: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistTurnEnded: vi.fn(() => ({ ok: true, value: undefined })),
  mockInvalidate: vi.fn(),
  mockBroadcast: vi.fn(),
  mockRefreshPr: vi.fn(),
}));

vi.mock("../../../src/services/agent/persistence", () => ({
  persistAgentSessionId: mockPersistAgentSessionId,
  persistCompaction: mockPersistCompaction,
  persistMessageStarted: mockPersistMessageStarted,
  persistPart: mockPersistPart,
  persistSessionError: mockPersistSessionError,
  persistSessionTitle: mockPersistSessionTitle,
  persistSessionUsage: mockPersistSessionUsage,
  persistTurnEnded: mockPersistTurnEnded,
}));

vi.mock("../../../src/services/query-engine", () => ({ invalidate: mockInvalidate }));
vi.mock("../../../src/services/ws.service", () => ({ broadcast: mockBroadcast }));
vi.mock("../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: mockRefreshPr,
}));

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
    it("persists the engine's user echo as the user message row", () => {
      const echo = messageStarted({ role: "user", outputIndex: 0, messageId: "user-msg" });

      handler.handle(envelope(echo));

      expect(mockPersistMessageStarted).toHaveBeenCalledWith(echo);
      // Matching by turnId is what lets the frontend reconcile its optimistic
      // bubble with this row.
      expect(mockPersistMessageStarted.mock.calls[0][0]).toMatchObject({
        role: "user",
        turnId: TURN,
      });
      expect(mockInvalidate).toHaveBeenCalledWith(["messages", "session"], {
        sessionIds: [SESSION],
      });
    });

    it("persists assistant messages with turn, parent tool call and model", () => {
      const event = messageStarted({ parentToolCallId: "tool-7", model: "claude-opus-5" });

      handler.handle(envelope(event));

      expect(mockPersistMessageStarted).toHaveBeenCalledWith(event);
      expect(pushedEnvelopes().at(-1)?.event).toMatchObject({ type: "message.started" });
    });

    it("skips invalidation when the write failed", () => {
      mockPersistMessageStarted.mockReturnValueOnce({ ok: false, error: "no session" } as never);

      handler.handle(envelope(messageStarted()));

      expect(mockInvalidate).not.toHaveBeenCalled();
      // The push still happens: live rendering must not depend on the write.
      expect(pushedEnvelopes()).toHaveLength(1);
    });
  });

  // ==========================================================================
  // parts
  // ==========================================================================

  describe("message.part / message.part.delta", () => {
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

    it("persists the snapshot and pushes it without invalidating", () => {
      handler.handle(envelope(partEvent));

      expect(mockPersistPart).toHaveBeenCalledWith(partEvent);
      expect(mockInvalidate).not.toHaveBeenCalled();
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

      expect(mockPersistPart).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
      expect(pushedEnvelopes()).toHaveLength(1);
    });
  });

  // ==========================================================================
  // turn.ended
  // ==========================================================================

  describe("turn.ended", () => {
    it("persists tokens and cost (they used to be computed and dropped)", () => {
      const event = turnEnded({
        tokens: { input: 100, output: 20, cache: { read: 5, write: 0 } },
        cost: 0.0123,
      });

      handler.handle(envelope(event));

      expect(mockPersistTurnEnded).toHaveBeenCalledWith(event, {
        status: "idle",
        cancelled: false,
      });
      expect(mockRefreshPr).toHaveBeenCalledWith(SESSION);
    });

    it("marks a cancelled turn instead of inserting a synthetic message", () => {
      handler.handle(envelope(turnEnded({ stopReason: "cancelled" })));

      expect(mockPersistTurnEnded).toHaveBeenCalledWith(expect.anything(), {
        status: "idle",
        cancelled: true,
      });
    });

    it.each(["refusal", "max_turn_requests"])(
      "leaves the session idle and persists the %s outcome",
      (stopReason) => {
        handler.handle(envelope(turnEnded({ stopReason })));

        expect(mockPersistTurnEnded).toHaveBeenCalledWith(expect.objectContaining({ stopReason }), {
          status: "idle",
          cancelled: false,
        });
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

      expect(mockPersistTurnEnded).toHaveBeenCalledWith(expect.anything(), {
        status: "error",
        cancelled: false,
        error: { message: "429 slow down", category: "rate_limit" },
      });
    });

    it("classifies the message when the engine reported no ErrorInfo", () => {
      handler.handle(envelope(turnEnded({ stopReason: "error" })));

      expect(mockPersistTurnEnded).toHaveBeenCalledWith(expect.anything(), {
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
      expect(mockPersistTurnEnded).toHaveBeenCalledWith(expect.anything(), {
        status: "error",
        cancelled: false,
      });
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

      expect(mockPersistSessionUsage).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(["workspaces", "sessions", "session", "stats"], {
        sessionIds: [SESSION],
      });
      expect(pushedEnvelopes()).toHaveLength(0);
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

      expect(mockPersistCompaction).toHaveBeenCalledWith(event);
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
      expect(mockInvalidate).not.toHaveBeenCalled();
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

      expect(mockPersistTurnEnded).toHaveBeenCalledWith(expect.anything(), {
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
