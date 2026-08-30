import { Hono } from "hono";
import { createSessionToken } from "@deus-hq/sdk";
import { getDatabase } from "../lib/database";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
  getAllSessions,
  getSessionById,
  getSessionRaw,
  getCompactions,
  getMessages,
  hasOlderMessages,
  hasNewerMessages,
  attachParts,
} from "../db";
import { invalidate } from "../services/query-engine";
import { getCloudConfig } from "../services/agent/cloud/config";

/**
 * Session Routes
 *
 * Sessions are associated with workspaces. Agent runtime (Claude SDK)
 * is managed by the agent-server (agent-server). This route handles:
 * - Session CRUD
 * - Session status updates
 *
 * User messages are written by the agent event pipeline (the engine's user
 * echo), not by a route. Frontend communicates with the agent-server via
 * WebSocket JSON-RPC.
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

  return c.json({
    messages: attachParts(db, messages),
    // The same list the WS `messages` query returns, and for the same reason:
    // compactions are positional siblings of messages, not parts, so a page
    // without them renders a transcript with every "context compacted" divider
    // missing. This route is the HTTP fallback for that query — it has to
    // answer the same shape, or the fallback silently degrades the transcript.
    compactions: getCompactions(db, sessionId),
    has_older,
    has_newer,
  });
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

/**
 * GET /sessions/:id/cloud-direct-token
 *
 * The "Mac-up" token seam for Path B (direct-agnt rendering). Mints a
 * session-scoped token so the BROWSER can open this cloud session's agnt
 * WebSocket directly, bypassing this backend's `q:` relay. The desktop backend
 * holds the cloud credentials, so it mints via the SDK's `createSessionToken`
 * (the same token its own socket uses). The fully-Mac-closed variant instead
 * mints from the browser's own `deus_cloud_session` via agnt's `/dashboard`
 * exchange — same engine, different token source.
 */
app.get("/sessions/:id/cloud-direct-token", async (c) => {
  const db = getDatabase();
  const session = getSessionRaw(db, c.req.param("id"));
  if (!session) throw new NotFoundError("Session not found");
  if (!session.provider_session_id) {
    throw new ValidationError("Not a cloud session");
  }

  const config = getCloudConfig();
  if (!config) {
    throw new ValidationError("Cloud is not configured on this device");
  }

  const { token } = await createSessionToken(session.provider_session_id, {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    expiresIn: 60 * 60,
  });

  return c.json({
    token,
    base_url: config.baseUrl,
    provider_session_id: session.provider_session_id,
  });
});

export default app;
