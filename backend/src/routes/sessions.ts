import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { getDatabase } from '../lib/database';
import { NotFoundError, ValidationError } from '../lib/errors';
import {
  getAllSessions,
  getSessionById,
  getSessionRaw,
  getMessages,
  hasOlderMessages,
  hasNewerMessages,
  getMessageById,
  getLatestUserMessage,
} from '../db';

/**
 * Session Routes
 *
 * Sessions are associated with workspaces. Agent runtime (Claude SDK)
 * is managed by sidecar-v2 (Rust-spawned). This route handles:
 * - Session CRUD
 * - User message persistence
 * - Session status updates
 *
 * Frontend communicates with sidecar-v2 via Tauri IPC for agent queries.
 */

const app = new Hono();

app.get('/sessions', (c) => {
  const db = getDatabase();
  return c.json(getAllSessions(db));
});

app.get('/sessions/:id', (c) => {
  const db = getDatabase();
  const session = getSessionById(db, c.req.param('id'));
  if (!session) throw new NotFoundError('Session not found');
  return c.json(session);
});

app.get('/sessions/:id/messages', (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');
  // Default limit high enough to avoid silent truncation until pagination UI is built.
  // Cap at 5000 to prevent unbounded responses.
  const limit = Math.min(Number(c.req.query('limit')) || 5000, 5000);
  // Cursor is seq (integer), not sent_at (string with collisions)
  const beforeRaw = c.req.query('before');
  const afterRaw = c.req.query('after');
  const before = beforeRaw ? Number(beforeRaw) : undefined;
  const after = afterRaw ? Number(afterRaw) : undefined;

  const messages = getMessages(db, sessionId, { limit, before, after });

  // Check if there are older/newer messages using seq boundaries
  const oldestSeq = messages.length > 0 ? messages[0].seq : null;
  const newestSeq = messages.length > 0 ? messages[messages.length - 1].seq : null;

  const has_older = oldestSeq != null ? hasOlderMessages(db, sessionId, oldestSeq) : false;
  const has_newer = newestSeq != null ? hasNewerMessages(db, sessionId, newestSeq) : false;

  return c.json({ messages, has_older, has_newer });
});

/**
 * POST /sessions/:id/messages
 *
 * Saves user message to database and updates session status.
 * Agent query is initiated via Tauri IPC → sidecar-v2, not here.
 * Returns immediately after DB write.
 */
app.post('/sessions/:id/messages', async (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');
  const { content, model } = await c.req.json();

  if (!content || typeof content !== 'string') {
    throw new ValidationError('content is required and must be a string');
  }

  const session = getSessionRaw(db, sessionId);
  if (!session) throw new NotFoundError('Session not found');

  const messageId = randomUUID();
  const sentAt = new Date().toISOString();
  const messageModel = (typeof model === 'string' && model) ? model : 'sonnet';

  const insertMessageAndUpdateSession = db.transaction(() => {
    db.prepare(`
      INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model)
      VALUES (?, ?, 'user', ?, datetime('now'), ?, ?)
    `).run(messageId, sessionId, content, sentAt, messageModel);

    db.prepare("UPDATE sessions SET status = 'working', last_user_message_at = ?, updated_at = datetime('now') WHERE id = ?").run(sentAt, sessionId);
  });

  insertMessageAndUpdateSession();

  const createdMessage = getMessageById(db, messageId);
  return c.json(createdMessage);
});

/**
 * POST /sessions/:id/stop
 *
 * Marks session as idle and cancels latest user message.
 * Actual agent cancellation is done via Tauri IPC → sidecar-v2.
 */
app.post('/sessions/:id/stop', (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');

  const session = getSessionRaw(db, sessionId);
  if (!session) throw new NotFoundError('Session not found');

  const latestUserMessage = getLatestUserMessage(db, sessionId);

  if (latestUserMessage) {
    db.prepare("UPDATE session_messages SET cancelled_at = datetime('now') WHERE id = ?").run(latestUserMessage.id);
  }

  db.prepare("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(sessionId);

  const updatedSession = getSessionRaw(db, sessionId);
  return c.json({
    success: true, session: updatedSession,
    message: latestUserMessage ? 'Session cancelled and message marked' : 'Session cancelled'
  });
});

export default app;
