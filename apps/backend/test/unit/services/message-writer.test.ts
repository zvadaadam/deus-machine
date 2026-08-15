import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTransaction, mockPrepare, mockRun, mockDb, mockGetSessionRaw } = vi.hoisted(() => {
  const mockRun = vi.fn<(...args: any[]) => any>(() => ({ changes: 1 }));
  const mockPrepare = vi.fn<(...args: any[]) => any>(() => ({ run: mockRun }));
  const mockTransaction = vi.fn<(...args: any[]) => any>((fn: () => void) => fn);
  const mockDb = {
    prepare: mockPrepare,
    transaction: mockTransaction,
  };
  const mockGetSessionRaw = vi.fn<(...args: any[]) => any>();
  return {
    mockTransaction,
    mockPrepare,
    mockRun,
    mockDb,
    mockGetSessionRaw,
  };
});

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn<(...args: any[]) => any>(() => mockDb),
}));

vi.mock("../../../src/db", () => ({
  getSessionRaw: mockGetSessionRaw,
}));

import { writeUserMessage } from "../../../src/services/message-writer";

describe("writeUserMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepare.mockReturnValue({ run: mockRun });
    mockTransaction.mockImplementation((fn: () => void) => fn);
    mockGetSessionRaw.mockReturnValue({ id: "sess-123" });
  });

  it("persists the message and updates session state", () => {
    const result = writeUserMessage("sess-123", "hello world", "sonnet");

    expect(result).toEqual({ success: true, messageId: expect.any(String) });
    if (!result.success) throw new Error("expected a successful write");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPrepare).toHaveBeenNthCalledWith(1, expect.stringContaining("INSERT INTO messages"));
    expect(mockRun).toHaveBeenNthCalledWith(
      1,
      result.messageId,
      "sess-123",
      "hello world",
      expect.any(String),
      "sonnet"
    );
    expect(mockPrepare).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE sessions SET status = 'working'")
    );
    expect(mockRun).toHaveBeenNthCalledWith(2, expect.any(String), "sess-123");
  });

  it("returns an error when the session is missing", () => {
    mockGetSessionRaw.mockReturnValue(undefined);

    const result = writeUserMessage("missing-session", "hello world", "claude-opus-4-7");

    expect(result).toEqual({ success: false, error: "Session not found" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
