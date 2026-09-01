import { describe, it, expect } from "vitest";
import {
  toolRequestFromMcpQuestion,
  buildMcpAnswerFrame,
} from "@/features/session/cloud/directSessionRegistry";

describe("toolRequestFromMcpQuestion (agnt mcp.question → renderer tool:request)", () => {
  it("maps agnt's question items onto the RPC handler's shape and rewrites the session id", () => {
    const request = toolRequestFromMcpQuestion(
      {
        type: "mcp.question",
        data: {
          questionId: "q-1",
          sessionId: "provider-session",
          questions: [
            { text: "Prefer A or B?", options: ["A", "B"], allowsMultiSelect: false },
            { text: "Any notes?" },
          ],
          timestamp: "2026-09-02T00:00:00Z",
        },
      },
      "deus-session"
    );
    expect(request).toEqual({
      requestId: "q-1",
      sessionId: "deus-session",
      method: "askUserQuestion",
      params: {
        sessionId: "deus-session",
        questions: [
          { question: "Prefer A or B?", options: ["A", "B"], multiSelect: false },
          { question: "Any notes?", options: [] },
        ],
      },
      timeoutMs: 24 * 60 * 60 * 1000,
    });
  });

  it("drops unusable items and returns null without a question id", () => {
    const request = toolRequestFromMcpQuestion(
      {
        type: "mcp.question",
        data: { questionId: "q-2", questions: [{ text: "   " }, "junk", null] },
      },
      "s"
    );
    expect(request?.params.questions).toEqual([]);
    expect(toolRequestFromMcpQuestion({ type: "mcp.question", data: {} }, "s")).toBeNull();
    expect(toolRequestFromMcpQuestion({ type: "mcp.question" }, "s")).toBeNull();
  });
});

describe("buildMcpAnswerFrame (renderer answer → agnt mcp.answer)", () => {
  it("nests the payload under data (the ClientCommand schema) with the PROVIDER session id", () => {
    expect(buildMcpAnswerFrame("q-1", "provider-session", { answers: ["A"] })).toEqual({
      type: "mcp.answer",
      data: { questionId: "q-1", sessionId: "provider-session", answers: ["A"] },
    });
  });

  it("turns an error/empty/odd response into the schema-valid cancellation so the agent unblocks", () => {
    for (const result of [undefined, null, {}, { answers: [] }, "nope"]) {
      expect(buildMcpAnswerFrame("q", "p", result).data).toMatchObject({
        answers: ["USER_CANCELLED"],
      });
    }
    expect(buildMcpAnswerFrame("q", "p", { answers: [1, "two"] }).data).toMatchObject({
      answers: ["1", "two"],
    });
  });
});
