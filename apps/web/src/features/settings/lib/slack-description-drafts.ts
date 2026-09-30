/**
 * Repository descriptions typed in Settings → Slack but not saved, by account
 * and environment. They live outside the rows because every way out of the
 * section unmounts them — the sidebar, Back to app, Escape, the command
 * palette, another organization — and guarding each exit would miss the next.
 */
const drafts = new Map<string, string>();

const draftKey = (accountId: string, environmentId: string) => `${accountId}:${environmentId}`;

export function readDescriptionDraft(accountId: string, environmentId: string): string | undefined {
  return drafts.get(draftKey(accountId, environmentId));
}

/** Keep `value` as a draft unless saving it would change nothing. */
export function writeDescriptionDraft(
  accountId: string,
  environmentId: string,
  value: string,
  saved: string
): void {
  if (value.trim() === saved) drafts.delete(draftKey(accountId, environmentId));
  else drafts.set(draftKey(accountId, environmentId), value);
}

export function clearDescriptionDraft(accountId: string, environmentId: string): void {
  drafts.delete(draftKey(accountId, environmentId));
}
