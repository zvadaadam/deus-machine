// sidecar/db/session-writer.ts
// Handles message persistence for assistant messages from all agent types.
// Stores normalized ContentBlock[] in `content` and raw SDK message in `full_message`.
// Also updates session status when queries complete.
//
// The `full_message` column may not exist in older production OpenDevs databases.
// We detect its presence at startup and gracefully fall back to INSERT without it.

import { randomUUID } from "crypto";
import { getDatabase } from "./index";
import { prepareMessageContent } from "./message-sanitizer";

// ============================================================================
// Column detection — cached at first use
// ============================================================================

let hasFullMessageColumn: boolean | null = null;

/**
 * Check if the session_messages table has a `full_message` column.
 * Cached after first check — the schema doesn't change at runtime.
 */
function detectFullMessageColumn(): boolean {
  if (hasFullMessageColumn !== null) return hasFullMessageColumn;

  try {
    const db = getDatabase();
    const columns = db.prepare("PRAGMA table_info(session_messages)").all() as Array<{
      name: string;
    }>;
    hasFullMessageColumn = columns.some((col) => col.name === "full_message");

    if (!hasFullMessageColumn) {
      console.log(
        "[SESSION-WRITER] full_message column not found — raw SDK messages will not be stored"
      );
    }
  } catch {
    hasFullMessageColumn = false;
  }

  return hasFullMessageColumn;
}

// ============================================================================
// Prepared statement cache
// ============================================================================

// Lazily cached prepared statements (better-sqlite3 prepared statements are reusable)
let insertWithFullMessage: ReturnType<ReturnType<typeof getDatabase>["prepare"]> | null = null;
let insertWithoutFullMessage: ReturnType<ReturnType<typeof getDatabase>["prepare"]> | null = null;

function getInsertStatement() {
  if (detectFullMessageColumn()) {
    if (!insertWithFullMessage) {
      insertWithFullMessage = getDatabase().prepare(
        `INSERT INTO session_messages (id, session_id, role, content, full_message, created_at, sent_at, model, sdk_message_id)
         VALUES (?, ?, 'assistant', ?, ?, datetime('now'), ?, ?, ?)`
      );
    }
    return { stmt: insertWithFullMessage, hasFullMessage: true };
  } else {
    if (!insertWithoutFullMessage) {
      insertWithoutFullMessage = getDatabase().prepare(
        `INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model, sdk_message_id)
         VALUES (?, ?, 'assistant', ?, datetime('now'), ?, ?, ?)`
      );
    }
    return { stmt: insertWithoutFullMessage, hasFullMessage: false };
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Save an assistant message to the database.
 * Stores normalized content in `content` column and raw SDK message in `full_message`
 * (if the column exists in the DB schema).
 *
 * @param sessionId - The session ID
 * @param message - The normalized message object (with ContentBlock[] in content)
 * @param model - The model name (e.g., "sonnet", "gpt-5.1-codex-max")
 * @param rawSdkMessage - Optional raw SDK message for debugging/replay (stored in full_message)
 * @param parentToolUseId - Optional parent tool_use_id for subagent message identification
 * @returns The generated message ID
 */
export function saveAssistantMessage(
  sessionId: string,
  message: { id?: string; role?: string; content?: unknown },
  model: string = "sonnet",
  rawSdkMessage?: unknown,
  parentToolUseId: string | null = null
): string | null {
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

  // Prepare raw SDK message for full_message column (best-effort, non-blocking)
  let rawContent: string | null = null;
  if (rawSdkMessage !== undefined) {
    const rawPrepared = prepareMessageContent(rawSdkMessage);
    if (rawPrepared.success) {
      rawContent = rawPrepared.content!;
    } else {
      console.warn(
        `[SESSION-WRITER] Failed to prepare raw SDK message, storing without it: ${rawPrepared.error}`
      );
    }
  }

  try {
    const { stmt, hasFullMessage } = getInsertStatement();

    if (hasFullMessage) {
      stmt.run(
        messageId,
        sessionId,
        prepared.content,
        rawContent,
        sentAt,
        model,
        message.id || null
      );
    } else {
      stmt.run(messageId, sessionId, prepared.content, sentAt, model, message.id || null);
    }

    console.log(`[SESSION-WRITER] Saved assistant message ${messageId} for session ${sessionId}`);
    return messageId;
  } catch (error) {
    console.error(`[SESSION-WRITER] Failed to save assistant message:`, error);
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

/**
 * Reset cached state. Used in tests to clear prepared statements and column detection.
 */
export function resetSessionWriterCache(): void {
  hasFullMessageColumn = null;
  insertWithFullMessage = null;
  insertWithoutFullMessage = null;
}
