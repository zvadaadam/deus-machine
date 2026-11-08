import { describe, it, expect } from "vitest";
import {
  toolRequestFromElicitation,
  buildElicitationResponseFrame,
} from "@/features/session/cloud/directSessionRegistry";

const QUESTIONS = [
  {
    id: "pref",
    question: "Prefer A or B?",
    options: [{ label: "A" }, { label: "B", description: "the other one" }],
  },
  { id: "notes", question: "Any notes?", multiSelect: true, options: [{ label: "Yes" }] },
];

describe("toolRequestFromElicitation (agnt elicitation.requested → renderer tool:request)", () => {
  it("maps the engine's questions onto the card's shape and rewrites the session id", () => {
    const asked = toolRequestFromElicitation(
      {
        type: "elicitation.requested",
        sessionId: "provider-session",
        turnId: "turn-1",
        requestId: "req-1",
        mode: "question",
        questions: QUESTIONS,
      },
      "deus-session"
    );
    expect(asked?.request).toEqual({
      requestId: "req-1",
      sessionId: "deus-session",
      method: "askUserQuestion",
      params: {
        sessionId: "deus-session",
        questions: [
          { question: "Prefer A or B?", options: ["A", "B"] },
          { question: "Any notes?", options: ["Yes"], multiSelect: true },
        ],
      },
      timeoutMs: 24 * 60 * 60 * 1000,
    });
    expect(asked?.questions).toEqual(QUESTIONS);
  });

  it("asks only what the card shows, so the answers stay keyed to the right questions", () => {
    const asked = toolRequestFromElicitation(
      {
        requestId: "req-2",
        mode: "question",
        questions: [{ id: "blank", question: "" }, ...QUESTIONS],
      },
      "deus-session"
    );
    expect(asked?.questions.map((q) => q.id)).toEqual(["pref", "notes"]);
    expect(
      buildElicitationResponseFrame("req-2", "p", asked!.questions, { answers: ["A", ["Yes"]] })
        .data
    ).toMatchObject({ outcome: { action: "accept", content: { pref: "A", notes: ["Yes"] } } });
  });

  it("returns null without a request id, outside question mode, or with nothing to ask", () => {
    expect(toolRequestFromElicitation({ mode: "question", questions: QUESTIONS }, "s")).toBeNull();
    expect(
      toolRequestFromElicitation({ requestId: "r", mode: "form", message: "Fill in" }, "s")
    ).toBeNull();
    expect(
      toolRequestFromElicitation({ requestId: "r", mode: "question", questions: [] }, "s")
    ).toBeNull();
    expect(
      toolRequestFromElicitation(
        { requestId: "r", mode: "question", questions: [null, { id: "x", question: " " }] },
        "s"
      )
    ).toBeNull();
  });
});

describe("buildElicitationResponseFrame (renderer answer → agnt elicitation.respond)", () => {
  it("nests the outcome under data with the PROVIDER session id, answers keyed by question id", () => {
    expect(
      buildElicitationResponseFrame("req-1", "provider-session", QUESTIONS, {
        answers: ["B", ["Yes"]],
      })
    ).toEqual({
      type: "elicitation.respond",
      data: {
        sessionId: "provider-session",
        requestId: "req-1",
        outcome: { action: "accept", content: { pref: "B", notes: ["Yes"] } },
      },
    });
  });

  it("cancels on an error/empty/odd response so the agent unblocks, and declines USER_CANCELLED", () => {
    for (const result of [undefined, null, {}, { answers: [] }, "nope"]) {
      expect(buildElicitationResponseFrame("r", "p", QUESTIONS, result).data).toMatchObject({
        outcome: { action: "cancel" },
      });
    }
    expect(
      buildElicitationResponseFrame("r", "p", QUESTIONS, { answers: ["USER_CANCELLED"] }).data
    ).toMatchObject({ outcome: { action: "decline" } });
  });

  it("declines a request Deus has no card for", () => {
    expect(buildElicitationResponseFrame("r", "p", [], null).data).toMatchObject({
      outcome: { action: "decline" },
    });
  });
});
