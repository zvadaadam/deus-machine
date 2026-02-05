// sidecar/agents/claude/claude-session.ts
// Session state management for Claude agent: active sessions, queries,
// settings comparison, termination, and session reuse logic.

import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryOptions } from "../agent-handler";

// ============================================================================
// Types
// ============================================================================

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
