import { describe, it, expect } from "vitest";
import {
  questionsFromAskUserQuestionInput,
  answeredAskUserQuestionInput,
  isCancelledAnswers,
  USER_CANCELLED_ANSWER,
} from "@shared/ask-user-question";

const input = {
  questions: [
    {
      question: "Which letter do you prefer?",
      header: "Letter",
      options: [
        { label: "A", description: "Prefer the letter A" },
        { label: "B", description: "Prefer the letter B" },
      ],
      multiSelect: false,
    },
    { question: "Anything else?", options: ["yes", "no"], multiSelect: true },
    { question: "   ", options: [] },
    "junk",
  ],
};

describe("questionsFromAskUserQuestionInput (built-in AskUserQuestion permission input)", () => {
  it("maps object AND string options to labels, keeps multiSelect, drops empties", () => {
    expect(questionsFromAskUserQuestionInput(input)).toEqual([
      { question: "Which letter do you prefer?", options: ["A", "B"], multiSelect: false },
      { question: "Anything else?", options: ["yes", "no"], multiSelect: true },
    ]);
    expect(questionsFromAskUserQuestionInput(null)).toEqual([]);
    expect(questionsFromAskUserQuestionInput({ questions: "nope" })).toEqual([]);
  });
});

describe("answeredAskUserQuestionInput (the updatedInput that answers it)", () => {
  it("keys answers by question text, index-aligned, joining multi-select arrays", () => {
    const answered = answeredAskUserQuestionInput(input, ["A", ["yes", "no"]]);
    expect(answered.answers).toEqual({
      "Which letter do you prefer?": "A",
      "Anything else?": "yes, no",
    });
    // The original input rides along untouched.
    expect(answered.questions).toBe(input.questions);
  });

  it("keys the answer by the exact wire text — whitespace included", () => {
    const answered = answeredAskUserQuestionInput(
      { questions: [{ question: "  Which one? ", options: ["A"] }] },
      ["A"]
    );
    expect(answered.answers).toEqual({ "  Which one? ": "A" });
  });

  it("keeps a question worded __proto__ as an own answer key", () => {
    const answered = answeredAskUserQuestionInput(
      { questions: [{ question: "__proto__", options: ["yes"] }] },
      ["yes"]
    );
    expect(Object.hasOwn(answered.answers as object, "__proto__")).toBe(true);
    // (An object literal with a __proto__ key sets the prototype, so compare the wire form.)
    expect(JSON.stringify(answered.answers)).toBe('{"__proto__":"yes"}');
  });

  it("tolerates fewer answers than questions", () => {
    expect(answeredAskUserQuestionInput(input, ["B"]).answers).toEqual({
      "Which letter do you prefer?": "B",
    });
  });
});

describe("isCancelledAnswers (the overlay's dismissal)", () => {
  it("treats nothing, an empty set and the USER_CANCELLED sentinel as declined", () => {
    expect(isCancelledAnswers(undefined)).toBe(true);
    expect(isCancelledAnswers([])).toBe(true);
    expect(isCancelledAnswers([USER_CANCELLED_ANSWER])).toBe(true);
    expect(isCancelledAnswers(["A"])).toBe(false);
    expect(isCancelledAnswers([["yes", "no"]])).toBe(false);
  });
});
