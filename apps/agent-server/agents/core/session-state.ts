// agent-server/agents/core/session-state.ts
// Per-deus-session state shared across the core modules: the engine factory
// reads it from hook/sdkOptions factories, the tool policy from edit guards,
// and the handler writes it at the start of every turn. One deus session id
// maps to exactly one harness (the DB primary key), recorded on first use.

import type { SessionUsageEvent } from "@zvada/agent-server/protocol";
import type { QueryOptions } from "../registry";

/** deus harness names → engine harness names (all three, no legacy path). */
export const ENGINE_HARNESS = {
  claude: "claude-code",
  "codex-sdk": "codex-sdk",
  "codex-server": "codex-app-server",
} as const;
export type DeusHarness = keyof typeof ENGINE_HARNESS;

export interface CoreSession {
  harness?: DeusHarness;
  turnId?: string;
  cwd?: string;
  nativeSessionId?: string;
  /** Set once the first successful turn has kicked off a title fetch. */
  titleFetched?: boolean;
  lastUsage?: SessionUsageEvent;
  /** Latest QueryOptions — read by the sdkOptions factory at session spawn. */
  lastOptions?: QueryOptions;
}

export const sessions = new Map<string, CoreSession>();

export function sessionState(sessionId: string): CoreSession {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {};
    sessions.set(sessionId, s);
  }
  return s;
}
