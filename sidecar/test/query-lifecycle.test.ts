import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSendMessage = vi.fn();
const mockSendError = vi.fn();
const mockSaveAssistantMessage = vi.fn();
const mockUpdateSessionStatus = vi.fn();

vi.mock("../frontend-client", () => ({
  FrontendClient: {
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    sendError: (...args: unknown[]) => mockSendError(...args),
  },
}));

vi.mock("../db/session-writer", () => ({
  saveAssistantMessage: (...args: unknown[]) => mockSaveAssistantMessage(...args),
  updateSessionStatus: (...args: unknown[]) => mockUpdateSessionStatus(...args),
}));

import { persistCancellation, notifyAndRecordError } from "../agents/query-lifecycle";
import type { ClassifiedError } from "../agents/error-classifier";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("persistCancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAssistantMessage.mockReturnValue({ ok: true });
    mockUpdateSessionStatus.mockReturnValue({ ok: true });
  });

  it("saves a cancelled assistant message to DB", () => {
    persistCancellation("session-1", "claude", "opus");

    expect(mockSaveAssistantMessage).toHaveBeenCalledWith(
      "session-1",
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stop_reason: "cancelled",
      },
      "opus"
    );
  });

  it("sends a cancelled notification to the frontend", () => {
    persistCancellation("session-1", "claude", "opus");

    expect(mockSendMessage).toHaveBeenCalledWith({
      id: "session-1",
      type: "message",
      agentType: "claude",
      data: { type: "cancelled" },
    });
  });

  it("updates session status to idle", () => {
    persistCancellation("session-1", "claude", "opus");

    expect(mockUpdateSessionStatus).toHaveBeenCalledWith("session-1", "idle");
  });

  it("works with codex agent type", () => {
    persistCancellation("session-2", "codex", "o3-mini");

    expect(mockSaveAssistantMessage).toHaveBeenCalledWith(
      "session-2",
      expect.objectContaining({ stop_reason: "cancelled" }),
      "o3-mini"
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: "codex" })
    );
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith("session-2", "idle");
  });

  it("sends db_write error when status update fails", () => {
    mockUpdateSessionStatus.mockReturnValue({ ok: false, error: "DB locked" });

    persistCancellation("session-1", "claude", "opus");

    expect(mockSendError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "db_write",
        error: expect.stringContaining("Session status update failed"),
      })
    );
  });

  it("does not send error when all DB writes succeed", () => {
    persistCancellation("session-1", "claude", "opus");

    expect(mockSendError).not.toHaveBeenCalled();
  });

  it("logs but continues when saveAssistantMessage fails", () => {
    mockSaveAssistantMessage.mockReturnValue({ ok: false, error: "Disk full" });

    persistCancellation("session-1", "claude", "opus");

    // Still sends notification and updates status
    expect(mockSendMessage).toHaveBeenCalled();
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith("session-1", "idle");
  });
});

describe("notifyAndRecordError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSessionStatus.mockReturnValue({ ok: true });
  });

  it("sends error to frontend", () => {
    const classified: ClassifiedError = { category: "auth", message: "Unauthorized" };
    notifyAndRecordError("session-1", "claude", classified);

    expect(mockSendError).toHaveBeenCalledWith({
      id: "session-1",
      type: "error",
      error: "Unauthorized",
      agentType: "claude",
      category: "auth",
    });
  });

  it("updates session status to error", () => {
    const classified: ClassifiedError = { category: "network", message: "Connection failed" };
    notifyAndRecordError("session-1", "claude", classified);

    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      "error",
      "Connection failed",
      "network"
    );
  });

  it("uses enrichMessage callback when provided", () => {
    const classified: ClassifiedError = { category: "process_exit", message: "Process exited" };
    const enrichFn = (c: ClassifiedError) => `${c.message} (enriched)`;

    notifyAndRecordError("session-1", "claude", classified, enrichFn);

    expect(mockSendError).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Process exited (enriched)" })
    );
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      "error",
      "Process exited (enriched)",
      "process_exit"
    );
  });

  it("uses classified message directly when no enrichMessage callback", () => {
    const classified: ClassifiedError = { category: "rate_limit", message: "Too many requests" };
    notifyAndRecordError("session-1", "codex", classified);

    expect(mockSendError).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Too many requests" })
    );
  });

  it("sends secondary db_write error when status update fails", () => {
    mockUpdateSessionStatus.mockReturnValue({ ok: false, error: "DB locked" });

    const classified: ClassifiedError = { category: "internal", message: "Something broke" };
    notifyAndRecordError("session-1", "claude", classified);

    // First call: the original error
    expect(mockSendError).toHaveBeenCalledTimes(2);

    // Second call: the db_write fallback error
    expect(mockSendError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "db_write",
        error: expect.stringContaining("Session status update failed"),
      })
    );
  });

  it("does not send secondary error when status update succeeds", () => {
    mockUpdateSessionStatus.mockReturnValue({ ok: true });

    const classified: ClassifiedError = { category: "internal", message: "Something broke" };
    notifyAndRecordError("session-1", "claude", classified);

    // Only one error call (the original)
    expect(mockSendError).toHaveBeenCalledTimes(1);
  });
});
