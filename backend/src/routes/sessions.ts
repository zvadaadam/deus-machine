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
  const messages = db.prepare(`
    SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(c.req.param('id'));
  return c.json(messages);
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

  db.prepare("UPDATE sessions SET status = 'working', updated_at = datetime('now') WHERE id = ?").run(sessionId);

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
