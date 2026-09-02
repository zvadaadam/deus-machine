// shared/ask-user-question.ts
// Claude Code's BUILT-IN AskUserQuestion collects its answers through the
// permission callback: the tool call arrives as a permission request whose
// `input` carries the questions, and the host "allows" it with an
// `updatedInput` that carries the answers. Both cloud lanes (the Mac driver
// and the browser's direct socket) meet that contract through these two pure
// helpers, so the question overlay never learns which lane asked.

/** One question as the overlay renders it (`useAgentRpcHandler`'s shape). */
export interface AskUserQuestionEntry {
  question: string;
  options: string[];
  multiSelect?: boolean;
}

interface RawQuestion {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

function optionLabel(option: unknown): string | null {
  if (typeof option === "string") return option.trim() || null;
  if (option && typeof option === "object") {
    const label = (option as { label?: unknown }).label;
    return typeof label === "string" && label.trim() ? label.trim() : null;
  }
  return null;
}

/**
 * The questions inside an AskUserQuestion permission request's `input`
 * (`{questions: [{question, header?, options: [{label, description}], multiSelect?}]}`).
 * Items without usable text are dropped; an input with none yields [] and the
 * caller should answer rather than park an invisible card.
 */
export function questionsFromAskUserQuestionInput(input: unknown): AskUserQuestionEntry[] {
  const raw =
    input && typeof input === "object" ? (input as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(raw)) return [];
  const entries: AskUserQuestionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as RawQuestion;
    if (typeof q.question !== "string" || !q.question.trim()) continue;
    const options = Array.isArray(q.options)
      ? q.options.map(optionLabel).filter((o): o is string => o !== null)
      : [];
    entries.push({
      question: q.question.trim(),
      options,
      ...(typeof q.multiSelect === "boolean" ? { multiSelect: q.multiSelect } : {}),
    });
  }
  return entries;
}

/**
 * The `updatedInput` that answers an AskUserQuestion permission request:
 * the original input plus `answers`, keyed by each question's text (the
 * tool's own contract), index-aligned with the overlay's answer list. A
 * multi-select answer may arrive as an array — joined the way the CLI
 * renders it.
 */
export function answeredAskUserQuestionInput(
  input: unknown,
  answers: ReadonlyArray<unknown>
): Record<string, unknown> {
  const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const questions = questionsFromAskUserQuestionInput(base);
  const map: Record<string, string> = {};
  questions.forEach((entry, index) => {
    const answer = answers[index];
    if (answer === undefined) return;
    map[entry.question] = Array.isArray(answer) ? answer.map(String).join(", ") : String(answer);
  });
  return { ...base, answers: map };
}

/** The overlay's dismissal sentinel — what `SessionPanel` resolves a closed
 *  question with. Both cloud lanes translate it into an honest deny. */
export const USER_CANCELLED_ANSWER = "USER_CANCELLED";

/** True when an answer set means "declined": missing, empty, or the sentinel. */
export function isCancelledAnswers(answers: unknown): boolean {
  return !Array.isArray(answers) || answers.length === 0 || answers[0] === USER_CANCELLED_ANSWER;
}
