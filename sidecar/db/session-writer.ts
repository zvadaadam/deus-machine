// sidecar/db/session-writer.ts
// Handles message persistence for SDK messages (assistant + tool_result).
// Also updates session status when queries complete.

import { randomUUID } from "crypto";
import { getDatabase } from "./index";
import { prepareMessageContent } from "./message-sanitizer";

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
  const messageId = randomUUID();
  const sentAt = new Date().toISOString();

  // Prepare the message content (sanitize for JSON integrity)
  // Include parent_tool_use_id in the envelope so frontend can identify subagent messages
  const contentEnvelope = parentToolUseId
    ? { message, parent_tool_use_id: parentToolUseId }
    : { message };
  const prepared = prepareMessageContent(contentEnvelope);

  if (!prepared.success) {
    console.error(`[SESSION-WRITER] Failed to prepare message content: ${prepared.error}`);
    return null;
  }

  try {
    db.prepare(
      `
      INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model, sdk_message_id)
      VALUES (?, ?, 'assistant', ?, datetime('now'), ?, ?, ?)
    `
    ).run(messageId, sessionId, prepared.content, sentAt, model, message.id || null);

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
  const messageId = randomUUID();
  const sentAt = new Date().toISOString();

  const contentEnvelope = parentToolUseId
    ? { message, parent_tool_use_id: parentToolUseId }
    : { message };
  const prepared = prepareMessageContent(contentEnvelope);

  if (!prepared.success) {
    console.error(`[SESSION-WRITER] Failed to prepare tool_result content: ${prepared.error}`);
    return null;
  }

  try {
    db.prepare(
      `
      INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, sdk_message_id)
      VALUES (?, ?, 'user', ?, datetime('now'), ?, ?)
    `
    ).run(messageId, sessionId, prepared.content, sentAt, message.id || null);

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
 */
export type SessionStatus = "idle" | "working" | "error";

export function updateSessionStatus(sessionId: string, status: SessionStatus): void {
  const db = getDatabase();

  try {
    db.prepare(
      `
      UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?
    `
    ).run(status, sessionId);

    console.log(`[SESSION-WRITER] Updated session ${sessionId} status to '${status}'`);
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
