/** Answers the operations in `shared/api/sessions.ts`. */

import * as api from "@shared/api/sessions";
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../lib/database";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
  attachParts,
  getAllSessions,
  getCompactions,
  getMessages,
  getSessionById,
  getSessionRaw,
  getSessionsByWorkspaceId,
  getTurnsForMessages,
  getWorkspaceRaw,
  hasOlderMessages,
} from "../db";
import { getCloudConfig } from "../services/agent/cloud/config";
import { mintCloudSessionToken } from "../services/agent/cloud/session-token";
import { sendMessage, stopSession } from "../services/agent/commands";
import { refreshWorkspaceGithubTokenIfStale } from "../services/cloud-workspace-init.service";
import { invalidate } from "../services/query-engine";
import { handle } from "./registry";

/** A page as large as a transcript is likely to be; older history is asked for with `before`. */
const DEFAULT_PAGE = 2000;

/**
 * The client renews its direct token at 80% of the token's hour (48 minutes).
 * A GitHub credential older than this at that moment would expire before the
 * next renewal, so it is refreshed now.
 */
const DIRECT_TOKEN_FRESH_MS = 10 * 60_000;
const DIRECT_TOKEN_SECONDS = 60 * 60;

export default [
  handle(api.sessions, ({ workspaceId }) => getSessionsByWorkspaceId(getDatabase(), workspaceId)),
  handle(api.session, ({ sessionId }) => getSessionById(getDatabase(), sessionId) ?? null),
  handle(api.messages, ({ sessionId, limit, before }) => {
    const db = getDatabase();
    const rows = getMessages(db, sessionId, { limit: limit ?? DEFAULT_PAGE, before });
    return {
      messages: attachParts(db, rows),
      compactions: getCompactions(db, sessionId),
      turns: getTurnsForMessages(db, sessionId, rows),
      has_older: rows.length > 0 ? hasOlderMessages(db, sessionId, rows[0].seq) : false,
      has_newer: false,
    };
  }),
  handle(api.allSessions, () => getAllSessions(getDatabase())),

  handle(api.cloudDirectToken, async ({ sessionId }) => {
    const session = getSessionRaw(getDatabase(), sessionId);
    if (!session) throw new NotFoundError("Session not found");
    if (!session.provider_session_id) throw new ValidationError("Not a cloud session");
    const config = getCloudConfig();
    if (!config) throw new ValidationError("Cloud is not configured on this device");

    // The client's own socket registers the session with its workspace, which
    // wakes a paused sandbox: the sandbox needs a GitHub credential that will
    // last. Best effort: a failed refresh never costs the token.
    if (session.workspace_id) {
      try {
        await refreshWorkspaceGithubTokenIfStale(session.workspace_id, DIRECT_TOKEN_FRESH_MS);
      } catch (error) {
        console.warn(`[Sessions] pre-connect token refresh failed: ${String(error)}`);
      }
    }
    const { token, expiresIn } = await mintCloudSessionToken(
      session.provider_session_id,
      config,
      DIRECT_TOKEN_SECONDS
    );
    return {
      token,
      base_url: config.baseUrl,
      provider_session_id: session.provider_session_id,
      expires_in: expiresIn,
    };
  }),

  handle(api.createSession, ({ workspaceId }) => {
    const db = getDatabase();
    if (!getWorkspaceRaw(db, workspaceId)) throw new NotFoundError("Workspace not found");
    const sessionId = uuidv7();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO sessions (id, workspace_id, status, updated_at) VALUES (?, ?, 'idle', datetime('now'))"
      ).run(sessionId, workspaceId);
      db.prepare(
        "UPDATE workspaces SET current_session_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(sessionId, workspaceId);
    })();
    invalidate(["workspaces", "sessions", "stats"]);
    return getSessionRaw(db, sessionId)!;
  }),
  handle(api.sendMessage, sendMessage),
  handle(api.stopSession, stopSession),
];
