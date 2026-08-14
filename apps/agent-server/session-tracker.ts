// agent-server/session-tracker.ts
// Per-session state the embed-tier seams need, fed by observing the wire:
// turn/start requests carry the config (cwd, harness, additionalDirectories),
// the event stream carries the native session id and turn boundaries. The
// tool policy reads cwd/additionalDirectories for its edit guard, the
// checkpoint hooks read cwd, and the title watcher reads nativeSessionId.
//
// Deus's backend always mints sessionId/turnId client-side (uuidv7) and sends
// both on turn/start — a request without a sessionId is simply not tracked.

import type { EngineHarness } from "@shared/enums";

export interface TrackedSession {
  harness: EngineHarness;
  cwd: string;
  additionalDirectories?: string[];
  /** Set while a turn is running; cleared on turn.ended. */
  turnId?: string;
  nativeSessionId?: string;
  /** Set once a title fetch has succeeded — retried at each turn end until then. */
  titleFetched?: boolean;
}

export const trackedSessions = new Map<string, TrackedSession>();

/** Record/refresh a session from an observed turn/start request. */
export function observeTurnStart(params: {
  sessionId?: string;
  turnId?: string;
  config?: { harness?: string; cwd?: string; additionalDirectories?: string[] };
}): void {
  const { sessionId, config } = params;
  if (!sessionId || !config?.harness || !config.cwd) return;
  const existing = trackedSessions.get(sessionId);
  trackedSessions.set(sessionId, {
    ...existing,
    harness: config.harness as EngineHarness,
    cwd: config.cwd,
    additionalDirectories: config.additionalDirectories,
    turnId: params.turnId ?? existing?.turnId,
  });
}

/** Record turn boundaries + native ids from the broadcast event stream. */
export function observeLifecycleEvent(event: {
  type: string;
  sessionId: string;
  turnId?: string;
  nativeSessionId?: string;
}): void {
  const state = trackedSessions.get(event.sessionId);
  if (!state) return;
  switch (event.type) {
    case "session.created":
      if (event.nativeSessionId) state.nativeSessionId = event.nativeSessionId;
      return;
    case "turn.started":
      if (event.turnId) state.turnId = event.turnId;
      return;
    case "turn.ended":
      // The turn is over — cancel-time checkpoints key "turn active" off
      // turnId; a stale id would fold post-turn edits into the end checkpoint.
      state.turnId = undefined;
      return;
    default:
  }
}
