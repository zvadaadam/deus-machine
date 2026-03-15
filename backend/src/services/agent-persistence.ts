// backend/src/services/agent-persistence.ts
// Database write functions for persisting agent events.
//
// STUB: PR 2 establishes the interface. PR 3 will implement the full
// persistence layer (migrating writes from sidecar/db/session-writer.ts
// to here in the backend).
//
// Currently, the sidecar writes directly to SQLite via better-sqlite3.
// The migration plan is:
//   1. Agent-server emits canonical events (PR 1 ✓)
//   2. Backend receives events via AgentClient (PR 2 — this file)
//   3. Backend persists events to DB (PR 3)
//   4. Remove direct DB writes from sidecar (PR 4)

import type {
  MessageAssistantEvent,
  MessageToolResultEvent,
  MessageResultEvent,
  MessageCancelledEvent,
  SessionStartedEvent,
  SessionIdleEvent,
  SessionErrorEvent,
  SessionCancelledEvent,
  AgentSessionIdEvent,
} from "../../../shared/agent-events";

// ============================================================================
// Session status writes
// ============================================================================

/** Update session status to "working" when a turn starts. */
export function persistSessionStarted(_event: SessionStartedEvent): void {
  // TODO: UPDATE sessions SET status = 'working' WHERE id = event.sessionId
}

/** Update session status to "idle" when a turn completes. */
export function persistSessionIdle(_event: SessionIdleEvent): void {
  // TODO: UPDATE sessions SET status = 'idle' WHERE id = event.sessionId
}

/** Update session status to "error" with error details. */
export function persistSessionError(_event: SessionErrorEvent): void {
  // TODO: UPDATE sessions SET status = 'error', error_message = event.error,
  //       error_category = event.category WHERE id = event.sessionId
}

/** Update session status after cancellation (back to idle). */
export function persistSessionCancelled(_event: SessionCancelledEvent): void {
  // TODO: UPDATE sessions SET status = 'idle' WHERE id = event.sessionId
}

// ============================================================================
// Message writes
// ============================================================================

/** Save an assistant message to session_messages. */
export function persistAssistantMessage(_event: MessageAssistantEvent): void {
  // TODO: INSERT INTO session_messages (id, session_id, role, content, ...)
  // Mirrors current sidecar/db/session-writer.ts saveAssistantMessage()
}

/** Save a tool result message to session_messages. */
export function persistToolResultMessage(_event: MessageToolResultEvent): void {
  // TODO: INSERT INTO session_messages (id, session_id, role, content, ...)
  // Mirrors current sidecar/db/session-writer.ts saveToolResultMessage()
}

/** Handle message.result events (success, error_during_execution). */
export function persistMessageResult(_event: MessageResultEvent): void {
  // TODO: Process usage stats, handle error_during_execution subtype
}

/** Persist a cancellation marker message. */
export function persistMessageCancelled(_event: MessageCancelledEvent): void {
  // TODO: INSERT cancellation marker into session_messages
}

// ============================================================================
// Metadata writes
// ============================================================================

/** Store the agent-provider session ID for resume support. */
export function persistAgentSessionId(_event: AgentSessionIdEvent): void {
  // TODO: UPDATE sessions SET agent_session_id = event.agentSessionId
  //       WHERE id = event.sessionId
}
