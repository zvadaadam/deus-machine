import { describe, expect, it } from "vitest";
import { PartsAccumulator } from "../../../src/services/agent/parts-accumulator";
import type { Part } from "../../../../shared/messages";

function textPart(id: string, messageId: string, text: string): Part {
  return { type: "TEXT", id, sessionId: "sess-1", messageId, text };
}

function toolPart(id: string, messageId: string, toolName: string): Part {
  return {
    type: "TOOL",
    id,
    sessionId: "sess-1",
    messageId,
    toolCallId: `tc-${id}`,
    toolName,
    state: { status: "PENDING", partialInput: "" },
  };
}

describe("PartsAccumulator", () => {
  it("accumulates parts and flushes them", () => {
    const acc = new PartsAccumulator();
    const p1 = textPart("p1", "msg-1", "Hello");
    const p2 = textPart("p2", "msg-1", " world");

    acc.accumulate("msg-1", [p1]);
    acc.accumulate("msg-1", [p2]);

    const flushed = acc.flush("msg-1");
    expect(flushed).toHaveLength(2);
    expect(flushed[0]).toEqual(p1);
    expect(flushed[1]).toEqual(p2);
  });

  it("merges parts by id (later value wins)", () => {
    const acc = new PartsAccumulator();
    const p1v1 = textPart("p1", "msg-1", "Hello");
    const p1v2 = textPart("p1", "msg-1", "Hello world");

    acc.accumulate("msg-1", [p1v1]);
    acc.accumulate("msg-1", [p1v2]);

    const flushed = acc.flush("msg-1");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].type === "TEXT" && flushed[0].text).toBe("Hello world");
  });

  it("tracks multiple messageIds independently", () => {
    const acc = new PartsAccumulator();
    acc.accumulate("msg-1", [textPart("p1", "msg-1", "first")]);
    acc.accumulate("msg-2", [textPart("p2", "msg-2", "second")]);

    expect(acc.size()).toBe(2);

    const flushed1 = acc.flush("msg-1");
    expect(flushed1).toHaveLength(1);
    expect(acc.size()).toBe(1);

    const flushed2 = acc.flush("msg-2");
    expect(flushed2).toHaveLength(1);
    expect(acc.size()).toBe(0);
  });

  it("returns empty array when flushing unknown messageId", () => {
    const acc = new PartsAccumulator();
    expect(acc.flush("nonexistent")).toEqual([]);
  });

  it("skips empty parts arrays without creating entries", () => {
    const acc = new PartsAccumulator();
    acc.accumulate("msg-1", []);
    expect(acc.has("msg-1")).toBe(false);
    expect(acc.size()).toBe(0);
  });

  it("cleans up after flush", () => {
    const acc = new PartsAccumulator();
    acc.accumulate("msg-1", [textPart("p1", "msg-1", "text")]);
    acc.flush("msg-1");

    expect(acc.has("msg-1")).toBe(false);
    expect(acc.flush("msg-1")).toEqual([]);
  });

  it("handles mixed part types", () => {
    const acc = new PartsAccumulator();
    const text = textPart("p1", "msg-1", "analysis");
    const tool = toolPart("p2", "msg-1", "bash");

    acc.accumulate("msg-1", [text, tool]);

    const flushed = acc.flush("msg-1");
    expect(flushed).toHaveLength(2);
    expect(flushed[0].type).toBe("TEXT");
    expect(flushed[1].type).toBe("TOOL");
  });
});
