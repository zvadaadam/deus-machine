// agent-server/agents/claude/claude-session.ts
// Session state management for Claude agent: active sessions, queries,
// settings comparison, termination, and session reuse logic.

import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryOptions } from "../registry";
import { SessionStore } from "../session-store";

// ============================================================================
// Types
// ============================================================================

/**
 * Mutable session record accumulated during a Claude SDK lifecycle.
 *
 * Lifecycle phases (fields set in each phase):
 *
 *   IDLE (freshly created via query() → claudeSessions.set):
 *     currentSettings, currentModel, currentMaxThinkingTokens, turnId, cwd
 *     generator/sendMessage/sendTerminate are undefined
 *
 *   ACTIVE (processWithGenerator running):
 *     All fields populated. generator + sendMessage + sendTerminate set
 *     by processWithGenerator after SDK query starts.
 *
 *   TERMINATED (terminateSession called, awaiting finally cleanup):
 *     generator + sendMessage deleted. sendTerminate fired.
 *     Session object is kept alive so processWithGenerator's finally block
 *     can compare `currentSession === session` (reference identity check)
 *     to avoid clobbering a rapid re-query's fresh session.
 *
 * Use `isSessionActive(session)` to check if a session is in the ACTIVE phase.
 */
export interface SessionState {
  generator?: AsyncIterator<SDKMessage>;
  sendMessage?: (message: string) => void;
  sendTerminate?: () => void;
  currentSettings?: {
    providerEnvVars?: string;
    additionalDirectories?: string[];
    chromeEnabled?: boolean;
    strictDataPrivacy?: boolean;
  };
  currentModel?: string;
  currentMaxThinkingTokens?: number;
  turnId?: string;
  /** Monotonically increasing counter — incremented on every query() call.
   *  Used by the streaming loop to detect turn boundaries when the generator is reused. */
  turnVersion: number;
  cwd?: string;
  /** One-shot flag: true after the first SDK message's session_id has been persisted to DB */
  agentSessionIdCaptured?: boolean;
  /** Set by cancel() before close() — checked by post-loop path to persist cancellation */
  cancelledByUser?: boolean;
}

// ============================================================================
// Session Stores
// ============================================================================

/** Active Claude sessions keyed by sessionId. */
export const claudeSessions = new SessionStore<SessionState>();

/** Active Claude SDK Query objects keyed by sessionId. */
export const claudeQueries = new SessionStore<Query>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a session is in the ACTIVE phase (generator running, can send messages).
 * Use this instead of manually checking `session.generator && session.sendMessage`.
 */
export function isSessionActive(session: SessionState | undefined): session is SessionState & {
  generator: AsyncIterator<SDKMessage>;
  sendMessage: (message: string) => void;
} {
  return !!session?.generator && !!session?.sendMessage;
}

/**
 * Compares old session settings with new options to determine
 * if the generator needs to be recreated.
 */
export function settingsChanged(
  oldSettings: SessionState["currentSettings"],
  newSettings: QueryOptions | undefined
): boolean {
  if (!oldSettings) return true;

  if (oldSettings.providerEnvVars !== newSettings?.providerEnvVars) {
    return true;
  }

  const oldDirs = oldSettings.additionalDirectories ?? [];
  const newDirs = newSettings?.additionalDirectories ?? [];
  if (oldDirs.length !== newDirs.length) return true;
  for (let i = 0; i < oldDirs.length; i++) {
    if (oldDirs[i] !== newDirs[i]) return true;
  }

  if ((oldSettings.chromeEnabled ?? false) !== (newSettings?.chromeEnabled ?? false)) {
    return true;
  }

  if ((oldSettings.strictDataPrivacy ?? false) !== (newSettings?.strictDataPrivacy ?? false)) {
    return true;
  }

  return false;
}

/**
 * Terminates the generator for a session (sends terminate signal,
 * cleans up generator and sendMessage references).
 */
export function terminateSession(sessionId: string): void {
  const session = claudeSessions.get(sessionId);
  if (session && session.sendTerminate) {
    session.sendTerminate();
    delete session.generator;
    delete session.sendMessage;
  }
  // Note: queries cleanup is owned by processWithGenerator's finally block.
  // We only signal termination here — the finally block calls claudeQueries.delete + claudeSessions.delete.
}
