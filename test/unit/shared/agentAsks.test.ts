import { describe, expect, it } from "vitest";
import {
  allowOnce,
  cardQuestions,
  isPlanRequest,
  planAnswer,
  questionAnswer,
  unansweredElicitations,
} from "@shared/agent-asks";

// The engine's plan question (agent-server's PLAN_OPTIONS) and a tool's approval.
const PLAN = [
  { optionId: "accept_edits", name: "Yes, and auto-accept edits", kind: "allow_always" },
  { optionId: "default", name: "Yes, and manually approve edits", kind: "allow_once" },
  { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
] as const;
const TOOL = [
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
] as const;

describe("what Deus answers the engine", () => {
  it("tells a plan from a tool's approval", () => {
    expect(isPlanRequest(PLAN)).toBe(true);
    expect(isPlanRequest(TOOL)).toBe(false);
  });

  it("implements an approved plan, and keeps planning on a rejected one", () => {
    expect(planAnswer(true)).toEqual({ outcome: "selected", optionId: "default" });
    expect(planAnswer(false)).toEqual({ outcome: "selected", optionId: "plan" });
  });

  it("allows a tool once, and cancels a request it cannot allow", () => {
    expect(allowOnce(TOOL)).toEqual({ outcome: "selected", optionId: "allow" });
    expect(allowOnce([TOOL[0]])).toEqual({ outcome: "selected", optionId: "allow_always" });
    expect(allowOnce([TOOL[2]])).toEqual({ outcome: "cancelled" });
  });

  it("shows the engine's questions on the question card, and takes its answers by question id", () => {
    const questions = [
      { id: "q1", question: "Which color?", options: [{ label: "red" }, { label: "blue" }] },
      {
        id: "q2",
        question: "Which sizes?",
        options: [{ label: "S" }, { label: "M" }],
        multiSelect: true,
      },
      { id: "q3", question: "Anything else?" },
    ];
    expect(cardQuestions(questions)).toEqual([
      { question: "Which color?", options: ["red", "blue"] },
      { question: "Which sizes?", options: ["S", "M"], multiSelect: true },
      { question: "Anything else?", options: [] },
    ]);
    expect(questionAnswer(questions, ["blue", ["S", "M"], ""])).toEqual({
      action: "accept",
      content: { q1: "blue", q2: ["S", "M"] },
    });
    expect(questionAnswer(questions, ["USER_CANCELLED"])).toEqual({ action: "decline" });
  });

  it("reads what a snapshot says is still unanswered in its live turn", () => {
    const ask = (requestId: string, turnId = "live") => ({
      type: "elicitation.requested",
      sessionId: "s",
      turnId,
      requestId,
      mode: "question",
      message: "Which?",
    });
    const receipt = { type: "interaction.receipt", status: "accepted", responseId: "r" };
    const snapshot = (interactions?: unknown[], currentTurnId: string | null = "live") => ({
      type: "session.snapshot",
      state: { currentTurnId },
      ...(interactions && { interactions }),
    });
    const interactions = [
      { request: ask("open") },
      { request: ask("answered"), receipt },
      { request: ask("old turn", "earlier") },
      { request: { type: "permission.request", turnId: "live", data: { requestId: "p" } } },
    ];

    expect(unansweredElicitations(snapshot(interactions))).toEqual([ask("open")]);
    // Between turns nothing is waiting; a platform that doesn't list them says nothing.
    expect(unansweredElicitations(snapshot(interactions, null))).toEqual([]);
    expect(unansweredElicitations(snapshot())).toBeNull();
  });
});
