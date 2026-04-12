import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { MessageRow, PartRow } from "../../../src/db/types";
import { getPartsByMessageIds, attachParts } from "../../../src/db/queries";

// ============================================================================
// Mock DB
// ============================================================================

const mockAll = vi.fn<(...args: unknown[]) => unknown[]>(() => []);
const mockDb = {
  prepare: vi.fn(() => ({ all: mockAll })),
} as unknown as Database.Database;

// ============================================================================
// Fixtures
// ============================================================================

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    session_id: "sess-1",
    seq: 1,
    role: "assistant",
    content: null,
    turn_id: null,
    model: "opus",
    agent_message_id: "sdk-msg-1",
    sent_at: "2026-01-01T00:00:00Z",
    cancelled_at: null,
    parent_tool_use_id: null,
    stop_reason: "end_turn",
    ...overrides,
  };
}

function makePart(overrides: Partial<PartRow> = {}): PartRow {
  return {
    id: "part-1",
    message_id: "msg-1",
    session_id: "sess-1",
    seq: 0,
    type: "TEXT",
    data: '{"type":"TEXT","text":"Hello"}',
    tool_call_id: null,
    tool_name: null,
    parent_tool_call_id: null,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("getPartsByMessageIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array for empty message IDs", () => {
    const result = getPartsByMessageIds(mockDb, []);
    expect(result).toEqual([]);
    expect(mockDb.prepare).not.toHaveBeenCalled();
  });

  it("queries parts with correct IN clause for single message", () => {
    const parts = [makePart()];
    mockAll.mockReturnValueOnce(parts);

    const result = getPartsByMessageIds(mockDb, ["msg-1"]);

    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE message_id IN (?)"));
    expect(mockAll).toHaveBeenCalledWith("msg-1");
    expect(result).toEqual(parts);
  });

  it("queries parts with correct IN clause for multiple messages", () => {
    const parts = [
      makePart({ id: "part-1", message_id: "msg-1" }),
      makePart({ id: "part-2", message_id: "msg-2" }),
    ];
    mockAll.mockReturnValueOnce(parts);

    const result = getPartsByMessageIds(mockDb, ["msg-1", "msg-2"]);

    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("WHERE message_id IN (?,?)")
    );
    expect(mockAll).toHaveBeenCalledWith("msg-1", "msg-2");
    expect(result).toEqual(parts);
  });

  it("includes ORDER BY message_id, seq for stable ordering", () => {
    mockAll.mockReturnValueOnce([]);
    getPartsByMessageIds(mockDb, ["msg-1"]);

    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY message_id, seq")
    );
  });
});

describe("attachParts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array for empty messages", () => {
    const result = attachParts(mockDb, []);
    expect(result).toEqual([]);
    expect(mockDb.prepare).not.toHaveBeenCalled();
  });

  it("attaches empty parts array when no parts exist", () => {
    mockAll.mockReturnValueOnce([]);
    const messages = [makeMessage({ id: "msg-1" })];

    const result = attachParts(mockDb, messages);

    expect(result).toHaveLength(1);
    expect(result[0].parts).toEqual([]);
    expect(result[0].id).toBe("msg-1");
    expect(result[0].role).toBe("assistant");
  });

  it("attaches parts to matching messages", () => {
    const parts = [
      makePart({ id: "part-1", message_id: "msg-1", seq: 0, type: "TEXT" }),
      makePart({ id: "part-2", message_id: "msg-1", seq: 1, type: "TOOL" }),
    ];
    mockAll.mockReturnValueOnce(parts);

    const messages = [makeMessage({ id: "msg-1" })];
    const result = attachParts(mockDb, messages);

    expect(result).toHaveLength(1);
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts[0].id).toBe("part-1");
    expect(result[0].parts[1].id).toBe("part-2");
  });

  it("distributes parts across multiple messages correctly", () => {
    const parts = [
      makePart({ id: "part-1", message_id: "msg-1", type: "TEXT" }),
      makePart({ id: "part-2", message_id: "msg-2", type: "TOOL" }),
      makePart({ id: "part-3", message_id: "msg-2", type: "TEXT" }),
    ];
    mockAll.mockReturnValueOnce(parts);

    const messages = [makeMessage({ id: "msg-1", seq: 1 }), makeMessage({ id: "msg-2", seq: 2 })];
    const result = attachParts(mockDb, messages);

    expect(result).toHaveLength(2);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].id).toBe("part-1");
    expect(result[1].parts).toHaveLength(2);
    expect(result[1].parts[0].id).toBe("part-2");
    expect(result[1].parts[1].id).toBe("part-3");
  });

  it("gives empty parts to messages with no matching parts", () => {
    const parts = [makePart({ id: "part-1", message_id: "msg-2" })];
    mockAll.mockReturnValueOnce(parts);

    const messages = [
      makeMessage({ id: "msg-1", seq: 1, role: "user" }),
      makeMessage({ id: "msg-2", seq: 2, role: "assistant" }),
    ];
    const result = attachParts(mockDb, messages);

    expect(result[0].parts).toEqual([]);
    expect(result[1].parts).toHaveLength(1);
    expect(result[1].parts[0].id).toBe("part-1");
  });

  it("preserves all original message fields", () => {
    mockAll.mockReturnValueOnce([]);
    const messages = [
      makeMessage({
        id: "msg-1",
        content: '{"text":"hello"}',
        model: "opus",
        stop_reason: "end_turn",
        parent_tool_use_id: "tool-123",
      }),
    ];

    const result = attachParts(mockDb, messages);

    expect(result[0].content).toBe('{"text":"hello"}');
    expect(result[0].model).toBe("opus");
    expect(result[0].stop_reason).toBe("end_turn");
    expect(result[0].parent_tool_use_id).toBe("tool-123");
  });
});
