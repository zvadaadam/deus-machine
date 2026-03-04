import { describe, it, expect } from "vitest";
import { parseContentBlocks, isCancelledMessage } from "@/features/session/lib/contentParser";

// ── parseContentBlocks ───────────────────────────────────────────────

describe("parseContentBlocks", () => {
  // Format 1: Plain text (user messages)
  describe("plain text (non-JSON)", () => {
    it("wraps plain text in a TextBlock array", () => {
      expect(parseContentBlocks("Fix the login bug")).toEqual([
        { type: "text", text: "Fix the login bug" },
      ]);
    });

    it("wraps multiline text", () => {
      expect(parseContentBlocks("Line 1\nLine 2")).toEqual([
        { type: "text", text: "Line 1\nLine 2" },
      ]);
    });

    it("wraps empty string", () => {
      expect(parseContentBlocks("")).toEqual([{ type: "text", text: "" }]);
    });
  });

  // Format 2: JSON ContentBlock[]
  describe("ContentBlock[] JSON", () => {
    it("returns text blocks", () => {
      const blocks = [{ type: "text", text: "Hello" }];
      expect(parseContentBlocks(JSON.stringify(blocks))).toEqual(blocks);
    });

    it("returns mixed blocks (text + tool_use + thinking)", () => {
      const blocks = [
        { type: "thinking", thinking: "Let me analyze..." },
        { type: "text", text: "Here is the answer" },
        { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/src/index.ts" } },
      ];
      expect(parseContentBlocks(JSON.stringify(blocks))).toEqual(blocks);
    });

    it("returns tool_result blocks", () => {
      const blocks = [
        { type: "tool_result", tool_use_id: "tu_1", content: "file contents...", is_error: false },
      ];
      expect(parseContentBlocks(JSON.stringify(blocks))).toEqual(blocks);
    });

    it("returns image blocks", () => {
      const blocks = [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        { type: "text", text: "What is this?" },
      ];
      expect(parseContentBlocks(JSON.stringify(blocks))).toEqual(blocks);
    });

    it("returns empty array for '[]'", () => {
      expect(parseContentBlocks("[]")).toEqual([]);
    });
  });

  // Format 3: Envelope (cancelled + legacy)
  describe("envelope format", () => {
    it("unwraps cancelled envelope", () => {
      const envelope = {
        message: { stop_reason: "cancelled" },
        blocks: [{ type: "text", text: "" }],
      };
      expect(parseContentBlocks(JSON.stringify(envelope))).toEqual([
        { type: "text", text: "" },
      ]);
    });

    it("unwraps cancelled envelope with empty blocks", () => {
      const envelope = { message: { stop_reason: "cancelled" }, blocks: [] };
      expect(parseContentBlocks(JSON.stringify(envelope))).toEqual([]);
    });

    it("unwraps cancelled envelope with multiple blocks", () => {
      const blocks = [
        { type: "thinking", thinking: "analyzing..." },
        { type: "text", text: "partial response" },
      ];
      const envelope = { message: { stop_reason: "cancelled" }, blocks };
      expect(parseContentBlocks(JSON.stringify(envelope))).toEqual(blocks);
    });

    it("unwraps legacy envelope with non-cancelled stop_reason", () => {
      const blocks = [{ type: "text", text: "response" }];
      const envelope = { message: { stop_reason: "max_tokens" }, blocks };
      expect(parseContentBlocks(JSON.stringify(envelope))).toEqual(blocks);
    });
  });

  // Edge cases
  describe("edge cases", () => {
    it("returns string when JSON.parse yields a string", () => {
      // JSON.stringify("hello") → '"hello"'
      expect(parseContentBlocks('"hello"')).toBe("hello");
    });

    it("wraps unexpected object as text", () => {
      expect(parseContentBlocks(JSON.stringify({ foo: "bar" }))).toEqual([
        { type: "text", text: '{"foo":"bar"}' },
      ]);
    });

    it("wraps JSON null as text", () => {
      expect(parseContentBlocks("null")).toEqual([
        { type: "text", text: "null" },
      ]);
    });

    it("wraps JSON number as text", () => {
      expect(parseContentBlocks("42")).toEqual([
        { type: "text", text: "42" },
      ]);
    });
  });
});

// ── isCancelledMessage ───────────────────────────────────────────────

describe("isCancelledMessage", () => {
  it("returns true for cancelled envelope", () => {
    const content = JSON.stringify({
      message: { stop_reason: "cancelled" },
      blocks: [{ type: "text", text: "" }],
    });
    expect(isCancelledMessage(content)).toBe(true);
  });

  it("returns true for cancelled envelope with empty blocks", () => {
    const content = JSON.stringify({
      message: { stop_reason: "cancelled" },
      blocks: [],
    });
    expect(isCancelledMessage(content)).toBe(true);
  });

  it("returns false for normal content blocks array", () => {
    expect(isCancelledMessage(JSON.stringify([{ type: "text", text: "hello" }]))).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(isCancelledMessage("Fix the bug")).toBe(false);
  });

  it("returns false for non-cancelled stop_reason", () => {
    const content = JSON.stringify({
      message: { stop_reason: "max_tokens" },
      blocks: [],
    });
    expect(isCancelledMessage(content)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCancelledMessage("")).toBe(false);
  });
});
