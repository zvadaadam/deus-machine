// sidecar/agents/claude/claude-session.ts
// Session state management for Claude agent: active sessions, queries,
// settings comparison, termination, and session reuse logic.

import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryOptions } from "../agent-handler";

// ============================================================================
// Types
// ============================================================================

/**
 * Mutable session record accumulated during a Claude SDK lifecycle.
 *
 * Lifecycle phases (fields set in each phase):
 *
 *   IDLE (freshly created via handleQuery → setSession):
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
    claudeEnvVars?: string;
    additionalDirectories?: string[];
    chromeEnabled?: boolean;
    strictDataPrivacy?: boolean;
  };
  currentModel?: string;
  currentMaxThinkingTokens?: number;
  turnId?: string;
  cwd?: string;
  /** One-shot flag: true after the first SDK message's session_id has been persisted to DB */
  agentSessionIdCaptured?: boolean;
}

// ============================================================================
// State
// ============================================================================

const activeSessions = new Map<string, SessionState>();
const queries = new Map<string, Query>();

// ============================================================================
// Public API
// ============================================================================

export function getSession(sessionId: string): SessionState | undefined {
  return activeSessions.get(sessionId);
}

export function setSession(sessionId: string, session: SessionState): void {
  activeSessions.set(sessionId, session);
}

export function deleteSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

export function getQuery(sessionId: string): Query | undefined {
  return queries.get(sessionId);
}

export function setQuery(sessionId: string, query: Query): void {
  queries.set(sessionId, query);
}

export function deleteQuery(sessionId: string): void {
  queries.delete(sessionId);
}

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

  const normalizeValue = (val: any) => (val === null || val === undefined ? undefined : val);

  if (normalizeValue(oldSettings.claudeEnvVars) !== normalizeValue(newSettings?.claudeEnvVars)) {
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
  const session = activeSessions.get(sessionId);
  if (session && session.sendTerminate) {
    session.sendTerminate();
    delete session.generator;
    delete session.sendMessage;
  }
  // Note: queries cleanup is owned by processWithGenerator's finally block.
  // We only signal termination here — the finally block calls deleteQuery + deleteSession.
}

/**
 * Clears all sessions and queries. Used in tests.
 */
export function clearAllSessions(): void {
  activeSessions.clear();
  queries.clear();
}
