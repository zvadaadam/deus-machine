// agent-server/agents/codex/codex-session.ts
// Session state management for Codex agent.
// Simpler than Claude's session state since Codex SDK exec mode is non-interactive
// (no mid-turn user messaging, no generator queue pattern).

import { SessionStore } from "../session-store";

// ============================================================================
// Types
// ============================================================================

export interface CodexSessionState {
  /** The Codex SDK thread ID (stored in ~/.codex/sessions/) */
  threadId?: string;
  /** AbortController for cancelling the current run */
  abortController?: AbortController;
  /** Current model being used */
  currentModel?: string;
  /** Working directory for this session */
  cwd?: string;
  /** Whether a query is currently running */
  isRunning: boolean;
}

// ============================================================================
// Session Store
// ============================================================================

/** Active Codex sessions keyed by sessionId. */
export const codexSessions = new SessionStore<CodexSessionState>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Aborts the current run for a session and marks it as not running.
 */
export function abortCodexSession(sessionId: string): void {
  const session = codexSessions.get(sessionId);
  if (session) {
    session.abortController?.abort();
    session.isRunning = false;
  }
}
