import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSendMessage = vi.fn();
const mockSendError = vi.fn();
const mockEmitSessionCancelled = vi.fn();
const mockEmitMessageCancelled = vi.fn();
const mockEmitSessionError = vi.fn();

vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: {
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    sendError: (...args: unknown[]) => mockSendError(...args),
    emitSessionCancelled: (...args: unknown[]) => mockEmitSessionCancelled(...args),
    emitMessageCancelled: (...args: unknown[]) => mockEmitMessageCancelled(...args),
    emitSessionError: (...args: unknown[]) => mockEmitSessionError(...args),
  },
}));

import {
  persistCancellation,
  notifyAndRecordError,
  type ClassifiedError,
} from "../agents/lifecycle";

// ── Helpers ────────────────────────────────────────────────────────────────

function expectCancellationEvents(sessionId: string, agentHarness: string) {
  expect(mockEmitSessionCancelled).toHaveBeenCalledWith(sessionId, agentHarness);
  expect(mockEmitMessageCancelled).toHaveBeenCalledWith(sessionId, agentHarness);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("persistCancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits canonical session.cancelled and message.cancelled events", () => {
    persistCancellation("session-1", "claude");
    expectCancellationEvents("session-1", "claude");
  });

  it("works with codex agent type", () => {
    persistCancellation("session-2", "codex");
    expectCancellationEvents("session-2", "codex");
  });

  it("does not send any error notifications", () => {
    persistCancellation("session-1", "claude");

    expect(mockEmitSessionError).not.toHaveBeenCalled();
  });
});

describe("notifyAndRecordError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits canonical session.error event", () => {
    const classified: ClassifiedError = { category: "auth", message: "Unauthorized" };
    notifyAndRecordError("session-1", "claude", classified);

    expect(mockEmitSessionError).toHaveBeenCalledWith(
      "session-1",
      "claude",
      "Unauthorized",
      "auth"
    );
  });

  it("emits canonical session.error for network errors", () => {
    const classified: ClassifiedError = { category: "network", message: "Connection failed" };
    notifyAndRecordError("session-1", "claude", classified);

    expect(mockEmitSessionError).toHaveBeenCalledWith(
      "session-1",
      "claude",
      "Connection failed",
      "network"
    );
  });

  it("uses enrichMessage callback when provided", () => {
    const classified: ClassifiedError = { category: "process_exit", message: "Process exited" };
    const enrichFn = (c: ClassifiedError) => `${c.message} (enriched)`;

    notifyAndRecordError("session-1", "claude", classified, enrichFn);

    expect(mockEmitSessionError).toHaveBeenCalledWith(
      "session-1",
      "claude",
      "Process exited (enriched)",
      "process_exit"
    );
  });

  it("uses classified message directly when no enrichMessage callback", () => {
    const classified: ClassifiedError = { category: "rate_limit", message: "Too many requests" };
    notifyAndRecordError("session-1", "codex", classified);

    expect(mockEmitSessionError).toHaveBeenCalledWith(
      "session-1",
      "codex",
      "Too many requests",
      "rate_limit"
    );
  });

  it("only emits one session.error event (no secondary db_write error)", () => {
    const classified: ClassifiedError = { category: "internal", message: "Something broke" };
    notifyAndRecordError("session-1", "claude", classified);

    // Only one error call — no DB writes means no DB failure path
    expect(mockEmitSessionError).toHaveBeenCalledTimes(1);
  });
});

// ── Canonical event emission ────────────────────────────────────────────

describe("persistCancellation canonical events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["claude", "session-1"],
    ["codex", "session-2"],
  ] as const)("emits both cancellation events for %s agent type", (agentHarness, sessionId) => {
    persistCancellation(sessionId, agentHarness);
    expectCancellationEvents(sessionId, agentHarness);
  });
});
