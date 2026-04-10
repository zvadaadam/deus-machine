import { describe, expect, it } from "vitest";
import {
  parseMessageParts,
  MessagePartsEnvelopeSchema,
  type Part,
  type TokenUsage,
  type MessagePartsEnvelope,
} from "@shared/messages";

const textPart: Part = {
  type: "TEXT",
  id: "part-1",
  sessionId: "sess-1",
  messageId: "msg-1",
  text: "Hello world",
  state: "DONE",
};

const toolPart: Part = {
  type: "TOOL",
  id: "part-2",
  sessionId: "sess-1",
  messageId: "msg-1",
  toolCallId: "tool-1",
  toolName: "Read",
  state: {
    status: "COMPLETED",
    input: { path: "/foo" },
    time: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:00:01Z" },
  },
  kind: "read",
};

const reasoningPart: Part = {
  type: "REASONING",
  id: "part-3",
  sessionId: "sess-1",
  messageId: "msg-1",
  text: "Let me think about this...",
  state: "DONE",
};

const usage: TokenUsage = { input: 1000, output: 200, cacheRead: 500 };

function makeEnvelope(overrides: Partial<MessagePartsEnvelope> = {}): MessagePartsEnvelope {
  return {
    parts: [textPart],
    usage,
    finishReason: "end_turn",
    cost: 0.003,
    ...overrides,
  };
}

describe("parseMessageParts", () => {
  it("parses a valid envelope with all fields", () => {
    const raw = JSON.stringify(makeEnvelope({ parts: [textPart, toolPart, reasoningPart] }));
    const result = parseMessageParts(raw);

    expect(result).not.toBeNull();
    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0].type).toBe("TEXT");
    expect(result!.parts[1].type).toBe("TOOL");
    expect(result!.parts[2].type).toBe("REASONING");
    expect(result!.usage).toEqual(usage);
    expect(result!.finishReason).toBe("end_turn");
    expect(result!.cost).toBe(0.003);
  });

  it("parses envelope with only parts (no usage/finishReason/cost)", () => {
    const raw = JSON.stringify({ parts: [textPart] });
    const result = parseMessageParts(raw);

    expect(result).not.toBeNull();
    expect(result!.parts).toHaveLength(1);
    expect(result!.usage).toBeUndefined();
    expect(result!.finishReason).toBeUndefined();
    expect(result!.cost).toBeUndefined();
  });

  it("parses envelope with null finishReason and cost", () => {
    const raw = JSON.stringify(makeEnvelope({ finishReason: null, cost: null }));
    const result = parseMessageParts(raw);

    expect(result).not.toBeNull();
    expect(result!.finishReason).toBeNull();
    expect(result!.cost).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseMessageParts(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseMessageParts(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseMessageParts("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseMessageParts("{not valid json")).toBeNull();
  });

  it("returns null for JSON that doesn't match the schema", () => {
    expect(parseMessageParts(JSON.stringify({ wrong: "shape" }))).toBeNull();
  });

  it("returns null for JSON with invalid part types", () => {
    const raw = JSON.stringify({ parts: [{ type: "INVALID", id: "x" }] });
    expect(parseMessageParts(raw)).toBeNull();
  });

  it("preserves all Part discriminant types through round-trip", () => {
    const allParts: Part[] = [
      textPart,
      reasoningPart,
      toolPart,
      { type: "STEP_START", id: "s1", sessionId: "sess-1", messageId: "msg-1" },
      {
        type: "STEP_FINISH",
        id: "s2",
        sessionId: "sess-1",
        messageId: "msg-1",
        finishReason: "end_turn",
        tokens: usage,
        cost: 0.003,
      },
      {
        type: "COMPACTION",
        id: "c1",
        sessionId: "sess-1",
        messageId: "msg-1",
        auto: true,
        preTokens: 5000,
      },
    ];
    const raw = JSON.stringify(makeEnvelope({ parts: allParts }));
    const result = parseMessageParts(raw);

    expect(result).not.toBeNull();
    expect(result!.parts).toHaveLength(6);
    expect(result!.parts.map((p) => p.type)).toEqual([
      "TEXT",
      "REASONING",
      "TOOL",
      "STEP_START",
      "STEP_FINISH",
      "COMPACTION",
    ]);
  });

  it("parses envelope with cache creation usage", () => {
    const usageWithCache: TokenUsage = {
      input: 1000,
      output: 200,
      cacheRead: 500,
      cacheCreation: { total: 300, ephemeral5m: 100 },
    };
    const raw = JSON.stringify(makeEnvelope({ usage: usageWithCache }));
    const result = parseMessageParts(raw);

    expect(result).not.toBeNull();
    expect(result!.usage?.cacheCreation?.total).toBe(300);
    expect(result!.usage?.cacheCreation?.ephemeral5m).toBe(100);
  });
});

describe("MessagePartsEnvelopeSchema", () => {
  it("validates a minimal envelope", () => {
    const result = MessagePartsEnvelopeSchema.safeParse({ parts: [] });
    expect(result.success).toBe(true);
  });

  it("rejects missing parts field", () => {
    const result = MessagePartsEnvelopeSchema.safeParse({ usage: { input: 0, output: 0 } });
    expect(result.success).toBe(false);
  });

  it("rejects invalid finishReason value", () => {
    const result = MessagePartsEnvelopeSchema.safeParse({
      parts: [],
      finishReason: "not_a_real_reason",
    });
    expect(result.success).toBe(false);
  });
});
