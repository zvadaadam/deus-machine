// What Deus answers when the engine asks. Deus runs agents with full access, so
// a tool's approval (`permission.requested`) is allowed; a plan is the user's
// to approve, on the plan card (Claude's ExitPlanMode and Codex's plan arrive
// the same way: the options are the modes to go on in); a question
// (`elicitation.requested`) is the user's to answer, on the question card.
import type {
  ElicitationOutcome,
  ElicitationQuestion,
  ElicitationRequestedEvent,
  PermissionOption,
  PermissionOutcome,
} from "@zvada/agent-server/protocol";

/** Whether the engine asks to implement a plan, rather than to run a tool. */
export function isPlanRequest(options: readonly PermissionOption[]): boolean {
  return options.some((option) => option.optionId === "plan");
}

/** A tool's approval: allowed once, as everything Deus's agents do is. */
export function allowOnce(options: readonly PermissionOption[]): PermissionOutcome {
  const allow =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always");
  return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
}

/** A plan answered: implement it in default mode, or keep planning (the turn ends; the user says what to change). */
export function planAnswer(approved: boolean): PermissionOutcome {
  return { outcome: "selected", optionId: approved ? "default" : "plan" };
}

/** A question as the question card shows it (the `askUserQuestion` the UI knows). */
export interface CardQuestion {
  question: string;
  options: string[];
  multiSelect?: boolean;
}

/** The card's answer when the user dismissed it. */
export const USER_CANCELLED = "USER_CANCELLED";

export function cardQuestions(questions: readonly ElicitationQuestion[]): CardQuestion[] {
  return questions.map((q) => ({
    question: q.question,
    options: (q.options ?? []).map((option) => option.label),
    ...(q.multiSelect && { multiSelect: true }),
  }));
}

/** The card's answers, one per question in order, as the engine takes them (by question id). */
export function questionAnswer(
  questions: readonly ElicitationQuestion[],
  answers: readonly (string | string[])[]
): ElicitationOutcome {
  if (answers.length === 1 && answers[0] === USER_CANCELLED) return { action: "decline" };
  const content: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const answer = answers[i];
    if (answer !== undefined && answer !== "") content[q.id] = answer;
  });
  return { action: "accept", content };
}

/**
 * What a session snapshot says the agent still waits on in its live turn: a
 * request nobody has answered yet. The frame that asked is not replayed, so a
 * client that connected after it, or whose socket was down, learns of it only
 * here. `null` when the platform does not list its requests.
 */
export function unansweredElicitations(
  snapshot: Record<string, unknown>
): ElicitationRequestedEvent[] | null {
  if (!Array.isArray(snapshot.interactions)) return null;
  const state = snapshot.state as { currentTurnId?: unknown } | undefined;
  const live = typeof state?.currentTurnId === "string" ? state.currentTurnId : null;
  if (!live) return [];
  return snapshot.interactions.flatMap((entry: unknown) => {
    const { request, receipt } = (entry ?? {}) as {
      request?: Partial<ElicitationRequestedEvent>;
      receipt?: unknown;
    };
    return request?.type === "elicitation.requested" &&
      receipt === undefined &&
      request.turnId === live &&
      typeof request.requestId === "string"
      ? [request as ElicitationRequestedEvent]
      : [];
  });
}
