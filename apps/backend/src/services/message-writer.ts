// backend/src/services/message-writer.ts
// Pure DB write — no side-effects (no invalidate, no broadcast).
// Callers are responsible for calling invalidate() after a successful write.
// This avoids the circular dependency: query-engine → message-writer → query-engine.

import { getDatabase } from "../lib/database";
import { getSessionRaw } from "../db";
import { uuidv7 } from "@shared/lib/uuid";
import { deriveSessionTitle } from "./title/derive";

/**
 * Persist a user message and mark session as working.
 * Returns the result; caller must call invalidate() on success.
 */
export function writeUserMessage(
  sessionId: string,
  content: string,
  model: string
): { success: true; messageId: string } | { success: false; error: string } {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) {
    return { success: false, error: "Session not found" };
  }

  const messageId = uuidv7();
  const sentAt = new Date().toISOString();
  const derivedTitle =
    session.message_count === 0 && !session.title ? deriveSessionTitle(content) : null;

  db.transaction(() => {
    db.prepare(
      `
      INSERT INTO messages (id, session_id, role, content, sent_at, model)
      VALUES (?, ?, 'user', ?, ?, ?)
    `
    ).run(messageId, sessionId, content, sentAt, model);

    db.prepare(
      "UPDATE sessions SET status = 'working', last_user_message_at = ?, error_message = NULL, error_category = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(sentAt, sessionId);

    if (derivedTitle) {
      db.prepare(
        "UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ? AND title IS NULL"
      ).run(derivedTitle, sessionId);
    }
  })();

  return { success: true, messageId };
}
