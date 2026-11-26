/** Answers the operations in `shared/api/sessions.ts`. */

import * as api from "@shared/api/sessions";
import { getDatabase } from "../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import {
  attachParts,
  createChat,
  getCompactions,
  getMessages,
  getSessionById,
  getSessionRaw,
  getSessionsByWorkspaceId,
  getTurnsForMessages,
  getWorkspaceRaw,
  hasOlderMessages,
} from "../db";
import { cloudAccount } from "../services/agent/cloud/config";
import { mintCloudSessionToken } from "../services/agent/cloud/session-token";
import { stopSession } from "../services/agent/turns";
import * as queue from "../services/agent/queue";
import { refreshWorkspaceGithubTokenIfStale } from "../services/cloud-workspace-init.service";
import { invalidate } from "../services/query-engine";
import { handle } from "./registry";

/** A page as large as a transcript is likely to be; older history is asked for with `before`. */
const DEFAULT_PAGE = 2000;
const emptyReply = () => ({});

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

  handle(api.cloudDirectToken, async ({ sessionId }) => {
    const session = getSessionRaw(getDatabase(), sessionId);
    if (!session) throw new NotFoundError("Session not found");
    if (!session.provider_session_id) throw new ValidationError("Not a cloud session");
    // The token is exchanged with the person's session: no organization key is needed.
    if (!cloudAccount()) throw new ValidationError("Cloud is not configured on this device");

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
    const account = cloudAccount();
    if (!account) throw new ValidationError("Cloud is not configured on this device");
    const { token, expiresIn } = await mintCloudSessionToken(
      session.provider_session_id,
      account,
      DIRECT_TOKEN_SECONDS
    );
    return {
      token,
      base_url: account.baseUrl,
      provider_session_id: session.provider_session_id,
      expires_in: expiresIn,
    };
  }),

  handle(api.createSession, ({ workspaceId }) => {
    const db = getDatabase();
    const workspace = getWorkspaceRaw(db, workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.state === "archived")
      throw new ConflictError("This workspace is archived. Restore it first to open a chat.");
    // A workspace's first chat is made by its start: a local one's once its
    // checkout exists, a cloud one's once its computer does. One made before
    // that would hide a failed start behind an empty chat, and take Retry and
    // Delete with it.
    if (
      !workspace.current_session_id &&
      (workspace.state === "initializing" || workspace.state === "error")
    ) {
      throw new ConflictError("This workspace has not started yet, so it has no chats.");
    }
    const sessionId = db.transaction(() => createChat(db, workspaceId, { select: true }))();
    invalidate(["workspaces", "sessions"]);
    return getSessionRaw(db, sessionId)!;
  }),
  // A client's send is the person's: no origin comes from the operation's input.
  handle(api.sendMessage, queue.sendOrQueue),
  handle(api.queuedMessages, ({ sessionId }) => queue.queuedMessages(sessionId)),
  handle(api.queuedMessage, ({ sessionId, id }) => queue.queuedMessage(sessionId, id)),
  handle(api.steerMessage, (input) => queue.steerMessage(input).then(emptyReply)),
  handle(api.steerQueuedMessage, ({ sessionId, id, turnId }) =>
    queue.steerQueuedMessage(sessionId, id, turnId, "front").then(emptyReply)
  ),
  handle(api.moveQueuedMessage, ({ sessionId, id, before }) =>
    queue.moveQueuedMessage(sessionId, id, before)
  ),
  handle(api.removeQueuedMessage, ({ sessionId, id }) => queue.removeQueuedMessage(sessionId, id)),
  handle(api.resumeQueuedMessages, ({ sessionId }) =>
    queue.resumeQueuedMessages(sessionId).then(emptyReply)
  ),
  handle(api.continueAfterLimit, ({ sessionId, on }) => queue.continueAfterLimit(sessionId, on)),
  // A client's stop is the person's.
  handle(api.stopSession, (input) => stopSession(input)),
];
