// backend/src/services/message-writer.ts
// Pure DB write — no side-effects (no invalidate, no broadcast).
// Callers are responsible for calling invalidate() after a successful write.
// This avoids the circular dependency: query-engine → message-writer → query-engine.

import { getDatabase } from "../lib/database";
import { getSessionRaw, getWorkspaceRaw } from "../db";
import { uuidv7 } from "@shared/lib/uuid";
import { seedWorkspaceTitleFromFirstPrompt } from "./workspace-title.service";

/**
 * Persist a user message and mark session as working.
 * Returns the result; caller must call invalidate() on success.
 */
export function writeUserMessage(
  sessionId: string,
  content: string,
  model?: string
): { success: true; messageId: string } | { success: false; error: string } {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) {
    return { success: false, error: "Session not found" };
  }

  const messageId = uuidv7();
  const sentAt = new Date().toISOString();
  const messageModel = model || "opus";

  db.transaction(() => {
    db.prepare(
      `
      INSERT INTO messages (id, session_id, role, content, sent_at, model)
      VALUES (?, ?, 'user', ?, ?, ?)
    `
    ).run(messageId, sessionId, content, sentAt, messageModel);

    db.prepare(
      "UPDATE sessions SET status = 'working', last_user_message_at = ?, error_message = NULL, error_category = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(sentAt, sessionId);

    // The first user prompt is the best early title signal until the branch or PR
    // becomes meaningful. Only seed when the workspace doesn't already have a
    // stronger title source.
    const workspace = getWorkspaceRaw(db, session.workspace_id);
    if (workspace) {
      seedWorkspaceTitleFromFirstPrompt(
        workspace.id,
        workspace.title,
        workspace.title_source,
        content
      );
    }
  })();

  return { success: true, messageId };
}
