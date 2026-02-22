// sidecar/db/session-writer.ts
// Handles message persistence for SDK messages (assistant + tool_result).
// Also updates session status when queries complete.

import { uuidv7 } from "../../shared/lib/uuid";
import { getDatabase } from "./index";

/**
 * Save an assistant message to the database.
 * Called after FrontendClient.sendMessage() in the Claude handler.
 *
 * @param sessionId - The session ID
 * @param message - The message object from Claude SDK
 * @returns The generated message ID
 */
export function saveAssistantMessage(
  sessionId: string,
  message: { id?: string; role?: string; content?: unknown },
  model: string = "opus",
  parentToolUseId: string | null = null
): string | null {
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();

  // Store content blocks directly (flattened — no envelope wrapper).
  // message.content is the blocks array from the SDK.
  const content = JSON.stringify(message.content ?? []);

  try {
    db.prepare(
      `
      INSERT INTO messages (id, session_id, role, content, sent_at, model, agent_message_id, parent_tool_use_id)
      VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
    `
    ).run(messageId, sessionId, content, sentAt, model, message.id || null, parentToolUseId);

    console.log(`[SESSION-WRITER] Saved assistant message ${messageId} for session ${sessionId}`);
    return messageId;
  } catch (error) {
    console.error(`[SESSION-WRITER] Failed to save assistant message:`, error);
    return null;
  }
}

/**
 * Save a user message containing tool_result blocks to the database.
 * The frontend's toolResultMap needs these to link tool_use → tool_result
 * for displaying execution results (success/failure/output).
 *
 * Without this, tool renderers never receive their result data and show
 * perpetual "in progress" state instead of actual output.
 */
export function saveToolResultMessage(
  sessionId: string,
  message: { id?: string; role?: string; content?: unknown },
  parentToolUseId: string | null = null
): string | null {
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();

  // Store content blocks directly (flattened — no envelope wrapper).
  const content = JSON.stringify(message.content ?? []);

  try {
    db.prepare(
      `
      INSERT INTO messages (id, session_id, role, content, sent_at, agent_message_id, parent_tool_use_id)
      VALUES (?, ?, 'user', ?, ?, ?, ?)
    `
    ).run(messageId, sessionId, content, sentAt, message.id || null, parentToolUseId);

    return messageId;
  } catch (error) {
    console.error(`[SESSION-WRITER] Failed to save tool_result message:`, error);
    return null;
  }
}

/**
 * Update session status (e.g., from 'working' to 'idle').
 * Called when a query completes (result.type === 'result' && result.subtype === 'success').
 *
 * @param sessionId - The session ID
 * @param status - The new status ('idle', 'working', 'error')
 * @param errorMessage - Optional error message (persisted when status is 'error', cleared otherwise)
 */
export type SessionStatus = "idle" | "working" | "error";

export function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  errorMessage?: string | null
): void {
  const db = getDatabase();

  try {
    db.prepare(
      `
      UPDATE sessions SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?
    `
    ).run(status, status === "error" ? (errorMessage ?? null) : null, sessionId);

    console.log(
      `[SESSION-WRITER] Updated session ${sessionId} status to '${status}'${errorMessage ? ` with error: ${errorMessage}` : ""}`
    );
  } catch (error) {
    console.error(`[SESSION-WRITER] Failed to update session status:`, error);
  }
}

/**
 * Update session's last_user_message_at timestamp.
 * Called when user sends a message (for optimized workspace list queries).
 *
 * @param sessionId - The session ID
 */
export function updateLastUserMessageAt(sessionId: string): void {
  const db = getDatabase();

  try {
    db.prepare(
      `
      UPDATE sessions SET last_user_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `
    ).run(sessionId);
  } catch (error) {
    console.error(`[SESSION-WRITER] Failed to update last_user_message_at:`, error);
  }
}

/**
 * Check if a session exists in the database.
 *
 * @param sessionId - The session ID
 * @returns true if session exists
 */
export function sessionExists(sessionId: string): boolean {
  const db = getDatabase();
  const result = db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
  return !!result;
}
