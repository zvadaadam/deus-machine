// agent-server/session-tracker.ts
// Per-session state the embed-tier seams need, fed by observing the wire:
// turn/start requests carry the config (cwd, harness, additionalDirectories),
// the event stream carries the native session id and turn boundaries. The
// tool policy reads cwd/additionalDirectories for its edit guard, the
// checkpoint hooks read cwd, and the title watcher reads nativeSessionId.
//
// Deus's backend always mints sessionId/turnId client-side (uuidv7) and sends
// both on turn/start — a request without a sessionId is simply not tracked.

import type { AgentHarness, McpServerConfig } from "@zvada/agent-server/protocol";

export interface TrackedSession {
  harness: AgentHarness;
  cwd: string;
  additionalDirectories?: string[];
  /** The MCP servers its turn brought (the installed apps'), kept through a swap of the AAP set. */
  mcpServers?: Record<string, McpServerConfig>;
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
  config?: {
    harness?: string;
    cwd?: string;
    additionalDirectories?: string[];
    mcpServers?: Record<string, McpServerConfig>;
  };
}): void {
  const { sessionId, config } = params;
  if (!sessionId || !config?.harness || !config.cwd) return;
  const existing = trackedSessions.get(sessionId);
  trackedSessions.set(sessionId, {
    ...existing,
    harness: config.harness as AgentHarness,
    cwd: config.cwd,
    additionalDirectories: config.additionalDirectories,
    mcpServers: config.mcpServers,
    turnId: params.turnId ?? existing?.turnId,
  });
}

/**
 * The wire servers a session carries: the AAP set, and over it the ones its
 * turn brought. What a turn starts with and what a swap of the AAP set leaves
 * it with are the same map.
 */
export function sessionServers(
  aapServers: Record<string, McpServerConfig>,
  turnServers: Record<string, McpServerConfig> | undefined
): Record<string, McpServerConfig> {
  return { ...aapServers, ...turnServers };
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
