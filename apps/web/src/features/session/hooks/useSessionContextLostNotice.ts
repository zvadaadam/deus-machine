/**
 * useSessionContextLostNotice — surface a silent resume failure.
 *
 * `session.created` carries `resumed`. When the harness was asked to continue
 * a conversation and answered `resumed: false`, it started a FRESH session:
 * the model has forgotten everything above this point. Claude mints a new
 * native session id even on a successful resume, so an id comparison reports
 * false negatives — the flag is the only truthful signal (protocol §6.1).
 *
 * Swallowing it is how "the agent forgot everything" becomes invisible, so
 * this is surfaced once per occurrence as a dismissible, non-blocking notice.
 * It is view state only: nothing is persisted, and it clears with the session.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api";
import { isUnknownEvent } from "@shared/protocol-types";
import { useStream } from "@/shared/hooks/useStream";

export function useSessionContextLostNotice(sessionId: string | null) {
  // Counter, not a boolean: a second resume failure must re-surface the notice
  // even if the first one was dismissed.
  const [occurrence, setOccurrence] = useState(0);
  const [dismissed, setDismissed] = useState(0);

  useEffect(() => {
    setOccurrence(0);
    setDismissed(0);
  }, [sessionId]);

  useStream(api.sessionEvents, sessionId ? { sessionId } : null, (update) => {
    if (update.type !== "event") return;
    const { event } = update.envelope;
    if (isUnknownEvent(event)) return;
    if (event.type === "session.created" && event.resumed === false) setOccurrence((n) => n + 1);
  });

  const dismiss = useCallback(() => setDismissed(occurrence), [occurrence]);

  return { contextLost: occurrence > dismissed, dismissContextLost: dismiss };
}
