// backend/src/services/assistants/waiting.ts
// What a chat's agent waits on, in the operator module's words, and a person's
// answer back in the words the app's own cards use.
//
// Deus relays a question to its question card as `askUserQuestion` (questions
// in order, each with option labels) and a plan to its plan card as
// `exitPlanMode` (the prompts, `isPrompt`); the cards answer `{ answers }` by
// position and `{ approved }` (shared/agent-asks.ts reads both back into the
// engine's outcomes; a plan sent back may carry `feedback`, what to change).
// The operator module speaks the engine's request shapes, so a request is
// translated on the way out and its answer on the way in, and an assistant's
// answer reaches the agent exactly as a card's would.

import { z } from "zod";
import {
  OperatorError,
  PLAN_OPTIONS,
  PLAN_TITLE,
  type Answer,
  type Waiting,
} from "@zvada/agent-server/operator";
import { USER_CANCELLED } from "@shared/agent-asks";
import type { ToolRequestEventData } from "@shared/types/query-protocol";
import { isPrompt, type ToolReply } from "../agent/tool-relay";

/** The questions as the question card is sent them (`cardQuestions`). */
const CardQuestions = z.array(
  z.object({
    question: z.string().min(1),
    options: z.array(z.string()).default([]),
    multiSelect: z.boolean().optional(),
  })
);

/** Implement the plan (in default mode): the card's `{ approved: true }`. */
const APPROVE = "default";
/** Keep planning: the card's `{ approved: false }`, with what to change. */
const KEEP_PLANNING = "plan";
/**
 * The engine's plan answers that Deus's card has: approve it, or keep
 * planning. (The card has no "auto-accept edits".) Keep planning is the one
 * the module reads as "this is a plan".
 */
const CARD_PLAN_OPTIONS = PLAN_OPTIONS.filter(
  (option) => option.optionId === APPROVE || option.optionId === KEEP_PLANNING
);

function questionsOf(request: ToolRequestEventData) {
  const parsed = CardQuestions.safeParse(request.params.questions);
  return parsed.success ? parsed.data : [];
}

/** A pending request as the operator shows it; null for one no person answers (a diff). */
export function waitingOf(request: ToolRequestEventData): Waiting | null {
  if (!isPrompt(request.method)) return null;
  if (request.method === "askUserQuestion") {
    const questions = questionsOf(request);
    if (questions.length === 0) return null;
    return {
      kind: "question",
      request: {
        requestId: request.requestId,
        mode: "question",
        message: questions[0]!.question,
        // The card answers by position, so a question's id is its position.
        questions: questions.map((q, index) => ({
          id: String(index),
          question: q.question,
          ...(q.options.length ? { options: q.options.map((label) => ({ label })) } : {}),
          ...(q.multiSelect ? { multiSelect: true } : {}),
        })),
      },
    };
  }
  if (request.method === "exitPlanMode") {
    const input = request.params.toolInput;
    return {
      kind: "decision",
      request: {
        requestId: request.requestId,
        title: PLAN_TITLE,
        toolCall: {
          toolName: "ExitPlanMode",
          ...(input && typeof input === "object" && !Array.isArray(input)
            ? { rawInput: input as Record<string, unknown> }
            : {}),
        },
        options: CARD_PLAN_OPTIONS,
      },
    };
  }
  return null;
}

/** One question's answer as the card gives it: a label, or several for a multi-select. */
function cardAnswer(given: unknown, options: readonly string[], multiSelect: boolean) {
  const words = Array.isArray(given)
    ? given.map(String)
    : given === undefined
      ? []
      : [String(given)];
  if (!multiSelect) return words.join(", ");
  // A word that is an option stays one, commas and all ("A, B" when it is one);
  // otherwise "a, b" names two options only when each piece is one of them.
  return words.flatMap((word) => {
    if (options.includes(word)) return [word];
    const pieces = word.split(/\s*,\s*/);
    return pieces.every((piece) => options.includes(piece)) ? pieces : [word];
  });
}

/** What the app's card would have answered for `answer`. */
export function replyFor(request: ToolRequestEventData, answer: Answer): ToolReply {
  if (request.method === "askUserQuestion" && answer.kind === "question") {
    const { outcome } = answer;
    if (outcome.action === "decline") return { result: { answers: [USER_CANCELLED] } };
    // No answers is the card's "dismissed": the request is cancelled and the agent goes on.
    if (outcome.action === "cancel") return { result: { answers: [] } };
    const content = outcome.content ?? {};
    const answers = questionsOf(request).map((q, index) =>
      cardAnswer(content[String(index)], q.options, q.multiSelect === true)
    );
    return { result: { answers } };
  }
  if (request.method === "exitPlanMode" && answer.kind === "decision") {
    const { outcome } = answer;
    if (outcome.outcome === "selected" && outcome.optionId === APPROVE) {
      return { result: { approved: true } };
    }
    // Sent back: what to change reaches the agent with the refusal (`planAnswer`).
    const feedback = outcome.outcome === "selected" ? outcome.message?.trim() : undefined;
    return { result: { approved: false, ...(feedback ? { feedback } : {}) } };
  }
  throw new OperatorError("That answer does not fit what the agent asked. Nothing was sent.");
}
