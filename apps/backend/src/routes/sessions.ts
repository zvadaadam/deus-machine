import { Hono } from "hono";
import { getDatabase } from "../lib/database";
import { NotFoundError } from "../lib/errors";
import { parseBody, CreateMessageBody } from "../lib/schemas";
import {
  getAllSessions,
  getSessionById,
  getSessionRaw,
  getMessages,
  hasOlderMessages,
  hasNewerMessages,
  getMessageById,
  attachParts,
} from "../db";
import { invalidate } from "../services/query-engine";
import { writeUserMessage } from "../services/message-writer";

/**
 * Session Routes
 *
 * Sessions are associated with workspaces. Agent runtime (Claude SDK)
 * is managed by the agent-server (agent-server). This route handles:
 * - Session CRUD
 * - User message persistence
 * - Session status updates
 *
 * Frontend communicates with the agent-server via WebSocket JSON-RPC.
 */

const app = new Hono();

app.get("/sessions", (c) => {
  const db = getDatabase();
  return c.json(getAllSessions(db));
});

app.get("/sessions/:id", (c) => {
  const db = getDatabase();
  const session = getSessionById(db, c.req.param("id"));
  if (!session) throw new NotFoundError("Session not found");
  return c.json(session);
});

app.get("/sessions/:id/messages", (c) => {
  const db = getDatabase();
  const sessionId = c.req.param("id");
  // Validate pagination: clamp limit to 1-500, reject non-positive cursors
  const rawLimit = Number(c.req.query("limit"));
  const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 500));
  // Pagination uses seq (integer), not sent_at (string with collisions)
  const beforeParsed = parseInt(c.req.query("before") ?? "", 10);
  const afterParsed = parseInt(c.req.query("after") ?? "", 10);
  const before = Number.isFinite(beforeParsed) && beforeParsed >= 1 ? beforeParsed : undefined;
  const after = Number.isFinite(afterParsed) && afterParsed >= 1 ? afterParsed : undefined;

  const messages = getMessages(db, sessionId, { limit, before, after });

  // Check if there are older/newer messages using seq boundaries
  const oldestSeq = messages.length > 0 ? messages[0].seq : null;
  const newestSeq = messages.length > 0 ? messages[messages.length - 1].seq : null;

  const has_older = oldestSeq != null ? hasOlderMessages(db, sessionId, oldestSeq) : false;
  const has_newer = newestSeq != null ? hasNewerMessages(db, sessionId, newestSeq) : false;

  return c.json({ messages: attachParts(db, messages), has_older, has_newer });
});

/**
 * POST /sessions/:id/messages
 *
 * Gateway/web fallback for saving user messages. The primary desktop path
 * now uses the agent-server socket (saveUserMessage in agent-server/db/session-writer.ts)
 * which atomically persists the message + dispatches the agent in one call.
 * This endpoint is kept for non-desktop clients (cloud relay, web gateway).
 */
app.post("/sessions/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  const { content, model } = parseBody(CreateMessageBody, await c.req.json());

  const result = writeUserMessage(sessionId, content, model);
  if (!result.success) throw new NotFoundError(result.error);

  invalidate(["workspaces", "sessions", "messages", "stats"]);

  const db = getDatabase();
  const createdMessage = getMessageById(db, result.messageId);
  return c.json(createdMessage);
});

/**
 * POST /sessions/:id/stop
 *
 * Marks session as idle and cancels latest user message.
 * Actual agent cancellation is done via WebSocket → agent-server.
 */
app.post("/sessions/:id/stop", (c) => {
  const db = getDatabase();
  const sessionId = c.req.param("id");

  const session = getSessionRaw(db, sessionId);
  if (!session) throw new NotFoundError("Session not found");

  db.prepare("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(
    sessionId
  );
  invalidate(["workspaces", "sessions", "stats"]);

  const updatedSession = getSessionRaw(db, sessionId);
  return c.json({ success: true, session: updatedSession });
});

export default app;
