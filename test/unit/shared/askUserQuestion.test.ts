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
