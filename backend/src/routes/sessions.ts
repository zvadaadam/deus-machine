import { Hono } from 'hono';
import { getDatabase } from '../lib/database';
import { NotFoundError } from '../lib/errors';
import { parseBody } from '../lib/validate';
import { CreateMessageBody } from '../lib/schemas';
import {
  getAllSessions,
  getSessionById,
  getSessionRaw,
  getMessages,
  hasOlderMessages,
  hasNewerMessages,
  getMessageById,
} from '../db';
import { invalidate } from '../services/query-engine';
import { writeUserMessage } from '../services/message-writer';

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
  // Default to 50 messages per page; cap at 500 for safety.
  const limit = Math.min(Number(c.req.query('limit')) || 50, 500);
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
 * Gateway/web fallback for saving user messages. The primary desktop path
 * now uses the sidecar socket (saveUserMessage in sidecar/db/session-writer.ts)
 * which atomically persists the message + dispatches the agent in one call.
 * This endpoint is kept for non-Tauri clients (cloud relay, web gateway).
 */
app.post('/sessions/:id/messages', async (c) => {
  const t0 = Date.now();
  const sessionId = c.req.param('id');
  const { content, model } = parseBody(CreateMessageBody, await c.req.json());

  const result = writeUserMessage(sessionId, content, model);
  if (!result.success) throw new NotFoundError(result.error);

  invalidate(['workspaces', 'sessions', 'messages', 'stats']);

  const db = getDatabase();
  const createdMessage = getMessageById(db, result.messageId);
  console.log(`[TIMING][sessions POST] session=${sessionId} total=${Date.now() - t0}ms`);
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

  db.prepare("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(sessionId);
  invalidate(['workspaces', 'sessions', 'stats']);

  const updatedSession = getSessionRaw(db, sessionId);
  return c.json({ success: true, session: updatedSession });
});

export default app;
