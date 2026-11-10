// backend/src/services/integrations/events.ts
// One place says "what is installed or connected changed". Several writes in
// one tick (a plugin installing ten parts) become one push to the clients.

import { invalidate } from "../query-engine";
import { getConnection, updateConnection } from "./store";

let scheduled = false;

export function integrationsChanged(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    invalidate(["integrations"]);
  });
}

/**
 * An account needs the person again (a refused refresh, a rejected key, a
 * sign-in that is gone): say why, and tell every open client. One function
 * for every kind of account, so none changes state without a push.
 */
export function markNeedsReauth(connectionId: string, reason: string): void {
  // Disconnected or removed meanwhile: its row waits for Deus Cloud to
  // confirm, and a late answer about its sign-in must not undo that.
  if (getConnection(connectionId)?.status === "removing") return;
  if (updateConnection(connectionId, { status: "needs_reauth", lastError: reason })) {
    integrationsChanged();
  }
}
