// agent-server/agents/codex-server/codex-server-session.ts
// Session state for the Codex app-server harness.

import { SessionStore } from "../session-store";
import type { CodexAppServerClient } from "./codex-server-client";

export interface CodexServerSessionState {
  /** Codex app-server thread id, persisted as sessions.agent_session_id. */
  threadId?: string;
  /** Active Codex turn id, needed for turn/interrupt. */
  turnId?: string;
  /** Persistent app-server process for this Deus session. */
  appServer?: CodexAppServerClient;
  /** Abort controller for the active turn. */
  abortController?: AbortController;
  /** Current model being used. */
  currentModel?: string;
  /** Working directory for this session. */
  cwd?: string;
  /** Whether a query is currently running. */
  isRunning: boolean;
  /** Whether the current app-server thread was started with active goal tools/instructions. */
  goalToolsActive?: boolean;
  /** Whether the thread includes the user-question dynamic tool. */
  allowQuestions?: boolean;
  /** Set when the user explicitly cancelled the turn. */
  cancelledByUser?: boolean;
}

export const codexServerSessions = new SessionStore<CodexServerSessionState>();

export function abortCodexServerSession(sessionId: string): void {
  const session = codexServerSessions.get(sessionId);
  if (!session) return;

  session.cancelledByUser = true;
  session.abortController?.abort();
  session.isRunning = false;
}

export function closeCodexServerSession(sessionId: string): void {
  const session = codexServerSessions.get(sessionId);
  if (!session) return;

  session.appServer?.close();
  codexServerSessions.delete(sessionId);
}
