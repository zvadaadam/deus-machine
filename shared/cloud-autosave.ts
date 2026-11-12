// A cloud turn saves its work to the branch when it ends. When that fails the
// reply is still good, so it is not an error of the turn: it is told apart, as
// a warning, wherever the turn's end is seen.

import { TurnEndedEventSchema } from "@deus-hq/api";

export interface CloudSaveFailure {
  sessionId: string;
  turnId: string;
  /** The provider's diagnostic, or what a conflict means. */
  error: string;
}

/** What a `turn.ended` says went wrong with saving; null when nothing did. */
export function cloudSaveFailure(event: unknown): CloudSaveFailure | null {
  const parsed = TurnEndedEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const { gitSync, sessionId, turnId } = parsed.data;
  const error =
    gitSync?.error ||
    (gitSync?.conflict ? "Git push hit a conflict with the remote repository." : undefined);
  return error ? { sessionId, turnId, error } : null;
}
