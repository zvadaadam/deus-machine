export interface RoutingRuleDraft {
  environmentId: string;
  description: string;
}

/**
 * The routing rule dialog's unsaved text, by account, organization and rule
 * (or a new one). It lives outside the dialog because browser Back unmounts
 * Settings without closing it; saving, Cancel and Escape close the dialog and
 * drop the draft.
 */
const drafts = new Map<string, RoutingRuleDraft>();

export const routingRuleDraftKey = (
  accountId: string,
  orgId: string,
  environmentId: string | null
) => `${accountId}:${orgId}:${environmentId ?? "new"}`;

export function readRoutingRuleDraft(key: string): RoutingRuleDraft | undefined {
  return drafts.get(key);
}

export function writeRoutingRuleDraft(key: string, draft: RoutingRuleDraft): void {
  drafts.set(key, draft);
}

export function dropRoutingRuleDraft(key: string): void {
  drafts.delete(key);
}
