// What a chat's agent waits on, in the operator's words, and an answer back
// as the app's own cards give it (services/assistants/waiting.ts).
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/agent/tool-relay", () => ({
  isPrompt: (method: string) => method === "askUserQuestion" || method === "exitPlanMode",
}));

import { replyFor, waitingOf } from "../../../src/services/assistants/waiting";

const question = {
  requestId: "q1",
  sessionId: "s",
  method: "askUserQuestion",
  params: {
    questions: [
      { question: "Which color?", options: ["red", "blue"] },
      { question: "Which sizes?", options: ["S", "M", "L"], multiSelect: true },
    ],
  },
} as never;
const plan = {
  requestId: "p1",
  sessionId: "s",
  method: "exitPlanMode",
  params: { toolInput: { plan: "1. do it" } },
} as never;

describe("a card's request and its answer", () => {
  it("a question: each answer by position, an option's label kept, a multi-select split on its options", () => {
    const waiting = waitingOf(question)!;
    expect(waiting.kind).toBe("question");
    // As the package reads "blue\nS, M": one answer per question, by its id (the position).
    const answer = {
      kind: "question",
      requestId: "q1",
      outcome: { action: "accept", content: { "0": "blue", "1": "S, M" } },
    } as never;
    expect(replyFor(question, answer)).toEqual({
      result: { answers: ["blue", ["S", "M"]] },
    });
  });

  it("a plan: a whole yes approves; anything else sends it back with what to change", () => {
    const waiting = waitingOf(plan)!;
    expect(waiting).toMatchObject({ kind: "plan", request: { purpose: "plan" } });
    const pick = (optionId: string, message?: string) =>
      ({
        kind: "decision",
        requestId: "p1",
        outcome: { outcome: "selected", optionId, ...(message ? { message } : {}) },
      }) as never;
    expect(replyFor(plan, pick("default"))).toEqual({ result: { approved: true } });
    expect(replyFor(plan, pick("plan", "drop step 3"))).toEqual({
      result: { approved: false, feedback: "drop step 3" },
    });
  });

  it("an answer that does not fit what was asked is refused", () => {
    expect(() =>
      replyFor(question, {
        kind: "decision",
        requestId: "q1",
        outcome: { outcome: "cancelled" },
      } as never)
    ).toThrow(/does not fit/);
  });
});
