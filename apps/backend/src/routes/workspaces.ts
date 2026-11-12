import { Hono } from "hono";
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../lib/database";
import { NotFoundError } from "../lib/errors";
import { readWorkspace } from "../api/workspaces";
import { getWorkspaceRaw, getSessionRaw, getSessionsByWorkspaceId } from "../db";
import { invalidate } from "../services/query-engine";

const app = new Hono();

// The desktop shell asks where a workspace's files are (main/native-handlers.ts).
// Everything else about workspaces is an operation: see api/workspaces.ts.
app.get("/workspaces/:id", (c) => c.json(readWorkspace(c.req.param("id"))));

// List all sessions for a workspace (used by chat tab reconstruction)
app.get("/workspaces/:id/sessions", (c) => {
  const db = getDatabase();
  const workspaceId = c.req.param("id");
  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new NotFoundError("Workspace not found");
  const sessions = getSessionsByWorkspaceId(db, workspaceId);
  return c.json(sessions);
});

// Create a new session for an existing workspace
app.post("/workspaces/:id/sessions", (c) => {
  const db = getDatabase();
  const workspaceId = c.req.param("id");

  const workspace = getWorkspaceRaw(db, workspaceId);
  if (!workspace) throw new NotFoundError("Workspace not found");

  const sessionId = uuidv7();

  const createSession = db.transaction(() => {
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, status, updated_at) VALUES (?, ?, 'idle', datetime('now'))"
    ).run(sessionId, workspaceId);

    db.prepare(
      "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId, workspaceId);
  });

  createSession();
  invalidate(["workspaces", "sessions", "stats"]);

  const session = getSessionRaw(db, sessionId);
  return c.json(session);
});

export default app;
