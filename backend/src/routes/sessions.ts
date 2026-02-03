import { Hono } from 'hono';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDatabase } from '../lib/database';
import { NotFoundError, ValidationError } from '../lib/errors';
import { startClaudeSession, sendToClaudeSession, stopClaudeSession } from '../services/claude.service';

const app = new Hono();

app.get('/sessions', (c) => {
  const db = getDatabase();
  const sessions = db.prepare(`
    SELECT s.*, w.directory_name, w.state as workspace_state,
           COUNT(m.id) as message_count
    FROM sessions s
    LEFT JOIN workspaces w ON s.id = w.active_session_id
    LEFT JOIN session_messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT 50
  `).all();
  return c.json(sessions);
});

app.get('/sessions/:id', (c) => {
  const db = getDatabase();
  const session = db.prepare(`
    SELECT s.*, w.directory_name, w.state as workspace_state,
           COUNT(m.id) as message_count
    FROM sessions s
    LEFT JOIN workspaces w ON s.id = w.active_session_id
    LEFT JOIN session_messages m ON m.session_id = s.id
    WHERE s.id = ?
    GROUP BY s.id
  `).get(c.req.param('id'));
  if (!session) throw new NotFoundError('Session not found');
  return c.json(session);
});

app.get('/sessions/:id/messages', (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');
  // Default limit high enough to avoid silent truncation until pagination UI is built.
  // Cap at 5000 to prevent unbounded responses.
  const limit = Math.min(Number(c.req.query('limit')) || 5000, 5000);
  const before = c.req.query('before'); // cursor: sent_at value (ms precision)
  const after = c.req.query('after');   // cursor: sent_at value (ms precision)

  // Cursors use `sent_at` (millisecond precision from JS Date.toISOString()) instead of
  // `created_at` (second precision from SQLite datetime('now')) to avoid skipping
  // messages that arrive in the same second. The existing idx_session_messages_sent_at
  // index on (session_id, sent_at) covers these queries.
  let query: string;
  let params: any[];

  if (before) {
    // Fetch older messages (before a cursor), return in ASC order
    query = `
      SELECT * FROM (
        SELECT * FROM session_messages
        WHERE session_id = ? AND sent_at < ?
        ORDER BY sent_at DESC
        LIMIT ?
      ) sub ORDER BY sent_at ASC
    `;
    params = [sessionId, before, limit];
  } else if (after) {
    // Fetch newer messages (after a cursor)
    query = `
      SELECT * FROM session_messages
      WHERE session_id = ? AND sent_at > ?
      ORDER BY sent_at ASC
      LIMIT ?
    `;
    params = [sessionId, after, limit];
  } else {
    // Default: fetch the most recent messages
    query = `
      SELECT * FROM (
        SELECT * FROM session_messages
        WHERE session_id = ?
        ORDER BY sent_at DESC
        LIMIT ?
      ) sub ORDER BY sent_at ASC
    `;
    params = [sessionId, limit];
  }

  const messages = db.prepare(query).all(...params);

  // Check if there are older/newer messages
  const oldest = messages.length > 0 ? (messages[0] as any).sent_at : null;
  const newest = messages.length > 0 ? (messages[messages.length - 1] as any).sent_at : null;

  const has_older = oldest
    ? !!(db.prepare('SELECT 1 FROM session_messages WHERE session_id = ? AND sent_at < ? LIMIT 1').get(sessionId, oldest))
    : false;

  const has_newer = newest
    ? !!(db.prepare('SELECT 1 FROM session_messages WHERE session_id = ? AND sent_at > ? LIMIT 1').get(sessionId, newest))
    : false;

  return c.json({ messages, has_older, has_newer });
});

app.post('/sessions/:id/messages', async (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');
  const { content } = await c.req.json();

  if (!content || typeof content !== 'string') {
    throw new ValidationError('content is required and must be a string');
  }

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new NotFoundError('Session not found');

  const messageId = randomUUID();
  const sentAt = new Date().toISOString();

  const lastAssistantMessage = db.prepare(`
    SELECT sdk_message_id FROM session_messages
    WHERE session_id = ? AND role = 'assistant' AND sdk_message_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(sessionId) as any;

  db.prepare(`
    INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model, last_assistant_message_id)
    VALUES (?, ?, 'user', ?, datetime('now'), ?, 'sonnet', ?)
  `).run(messageId, sessionId, content, sentAt, lastAssistantMessage?.sdk_message_id || null);

  db.prepare("UPDATE sessions SET status = 'working', last_user_message_at = ?, updated_at = datetime('now') WHERE id = ?").run(sentAt, sessionId);

  const workspace = db.prepare(`
    SELECT w.*, r.root_path FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    WHERE w.active_session_id = ?
  `).get(sessionId) as any;

  if (!workspace || !workspace.root_path || !workspace.directory_name) {
    throw new ValidationError('Workspace not found for session');
  }

  const workspacePath = path.join(workspace.root_path, '.conductor', workspace.directory_name);
  startClaudeSession(sessionId, workspacePath);
  sendToClaudeSession(sessionId, content);

  const createdMessage = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(messageId);
  return c.json(createdMessage);
});

app.post('/sessions/:id/stop', (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new NotFoundError('Session not found');

  const latestUserMessage = db.prepare(`
    SELECT * FROM session_messages
    WHERE session_id = ? AND role = 'user' AND cancelled_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(sessionId) as any;

  if (latestUserMessage) {
    db.prepare("UPDATE session_messages SET cancelled_at = datetime('now') WHERE id = ?").run(latestUserMessage.id);
  }

  stopClaudeSession(sessionId);
  db.prepare("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(sessionId);

  const updatedSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  return c.json({
    success: true, session: updatedSession,
    message: latestUserMessage ? 'Session cancelled and message marked' : 'Session cancelled'
  });
});

export default app;
