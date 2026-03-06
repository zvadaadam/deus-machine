// backend/src/services/relay.service.ts
// Manages the outbound WebSocket tunnel to the cloud relay.
// Creates virtual WsConnections in ws.service for relay-forwarded clients.
// Registers extended protocol handlers (data requests, session watching, send_message)
// that work for both local WS and relay-tunneled connections.

import { execSync } from "child_process";
import { hostname, userInfo, platform } from "os";
import { WebSocket } from "ws";
import { match } from "ts-pattern";
import type { ServerFrame, RelayFrame } from "../../../shared/types/relay";
import { uuidv7 } from "../../../shared/lib/uuid";
import { getSetting } from "./settings.service";
import { getRelayCredentials } from "./auth.service";
import {
  addConnection,
  removeConnection,
  getConnection,
  setProtocolHandlers,
  handleProtocolMessage,
  type WsSendable,
} from "./ws.service";
import { validateDeviceToken, validatePairCode, createDeviceToken } from "./auth.service";
import { getDatabase } from "../lib/database";
import { getDashboardWorkspaces, getStats, getSessionRaw, getMessageById } from "../db";
import { broadcastWorkspacesAndStats } from "./dashboard-broadcast";
import { handleFrame as handleQueryFrame, removeSubs as removeQuerySubs, invalidate } from "./query-engine";

// ---- Tunnel State ----

let tunnelWs: WebSocket | null = null;
let relayUrl: string | null = null;
let serverId: string | null = null;
let relayToken: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

// ---- Bidirectional Client Map ----
// Maps relay clientId <-> ws.service connectionId. Both directions O(1).
// The invariant: every key in clientToConn exists exactly once in connToClient.

const clientToConn = new Map<string, string>();
const connToClient = new Map<string, string>();

function linkClient(clientId: string, connectionId: string): void {
  clientToConn.set(clientId, connectionId);
  connToClient.set(connectionId, clientId);
}

function unlinkClient(clientId: string): string | undefined {
  const connectionId = clientToConn.get(clientId);
  if (connectionId) connToClient.delete(connectionId);
  clientToConn.delete(clientId);
  return connectionId;
}

function unlinkAll(): void {
  clientToConn.clear();
  connToClient.clear();
}

// ---- Session Watcher ----
// Server-side push of message deltas to watching clients.
// Works for both local WS and relay connections via WsSendable.

interface SessionWatch {
  sessionId: string;
  lastSeq: number;
}

const clientWatches = new Map<string, SessionWatch>();
let watcherInterval: ReturnType<typeof setInterval> | null = null;
const WATCHER_POLL_MS = 1_000;

const MAX_RECONNECT_DELAY = 30_000;
const BASE_RECONNECT_DELAY = 1_000;

// ---- Server Name Detection ----

function getServerName(): string {
  const custom = getSetting("server_name") as string | undefined;
  if (custom) return custom;

  if (platform() === "darwin") {
    try {
      const name = execSync("scutil --get ComputerName", { encoding: "utf-8", timeout: 2000 }).trim();
      if (name) return name;
    } catch { /* fall through */ }
  }

  const host = hostname().replace(/\.local$/, "");
  if (host && host !== "localhost") return host;

  try {
    return `${userInfo().username}'s computer`;
  } catch {
    return "Deus Server";
  }
}

// ---- Extended Protocol Handlers ----
// Registered once at module load. These handle request/watch_session/send_message
// for ALL authenticated connections (local WS + relay virtual).

setProtocolHandlers({
  onRequest: handleDataRequest,
  onWatchSession: handleWatchSession,
  onSendMessage: handleSendMessage,
  onQueryFrame: handleQueryFrame,
});

// ---- Public API ----

export function connectToRelay(url: string, id: string, token: string): void {
  relayUrl = url;
  serverId = id;
  relayToken = token;
  reconnectAttempt = 0;
  openTunnel();
}

export function disconnectFromRelay(): void {
  relayUrl = null;
  serverId = null;
  relayToken = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (tunnelWs) {
    tunnelWs.close(1000, "Disconnecting");
    tunnelWs = null;
  }
  for (const [, connId] of clientToConn) {
    removeQuerySubs(connId);
    clientWatches.delete(connId);
    removeConnection(connId);
  }
  unlinkAll();
  stopWatcherIfEmpty();
}

export function getRelayStatus(): { connected: boolean; clients: number; serverId: string | null; relayUrl: string | null } {
  const effectiveUrl = relayUrl ?? (getSetting("relay_url") as string | undefined) ?? null;
  const creds = serverId ? null : getRelayCredentials();
  const effectiveServerId = serverId ?? creds?.serverId ?? null;

  return {
    connected: tunnelWs?.readyState === WebSocket.OPEN,
    clients: clientToConn.size,
    serverId: effectiveServerId,
    relayUrl: effectiveUrl,
  };
}

/** Immediately run one tick of the session watcher (for /api/notify). */
export function triggerWatcherTick(): void {
  tickWatcher();
}

// ---- Tunnel Lifecycle ----

function openTunnel(): void {
  if (!relayUrl || !serverId || !relayToken) return;

  const wsUrl = `${relayUrl}/api/servers/${serverId}/tunnel?token=${encodeURIComponent(relayToken)}`;
  console.log(`[Relay] Connecting to ${relayUrl}/api/servers/${serverId}/tunnel...`);

  try {
    tunnelWs = new WebSocket(wsUrl);
  } catch (err) {
    console.error("[Relay] Failed to create WebSocket:", err);
    scheduleReconnect();
    return;
  }

  tunnelWs.on("open", () => {
    console.log("[Relay] Tunnel connected, registering...");
    reconnectAttempt = 0;
    sendToRelay({ type: "register", serverId: serverId!, relayToken: relayToken!, serverName: getServerName() });
  });

  tunnelWs.on("message", (raw: Buffer | string) => {
    try {
      const frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as RelayFrame;
      handleRelayFrame(frame);
    } catch {
      // Ignore malformed frames
    }
  });

  tunnelWs.on("close", (code, reason) => {
    console.log(`[Relay] Tunnel closed: ${code} ${reason}`);
    tunnelWs = null;
    for (const [, connId] of clientToConn) {
      removeQuerySubs(connId);
      clientWatches.delete(connId);
      removeConnection(connId);
    }
    unlinkAll();
    stopWatcherIfEmpty();
    if (relayUrl) scheduleReconnect();
  });

  tunnelWs.on("error", (err) => {
    console.error("[Relay] Tunnel error:", err.message);
  });
}

function handleRelayFrame(frame: RelayFrame): void {
  match(frame)
    .with({ type: "registered" }, () => {
      console.log("[Relay] Registered with relay successfully");
    })
    .with({ type: "client_connected" }, (f) => {
      const device = validateDeviceToken(f.deviceToken);
      if (device) {
        // Clean up existing connection (idempotent on tunnel reconnect)
        const existingConnId = clientToConn.get(f.clientId);
        if (existingConnId) {
          removeQuerySubs(existingConnId);
          clientWatches.delete(existingConnId);
          removeConnection(existingConnId);
        }

        // Virtual WsSendable routes data back through the relay tunnel
        const virtualWs: WsSendable = {
          send(data: string | ArrayBuffer) {
            const payload = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
            sendToRelay({ type: "data", clientId: f.clientId, payload });
          },
          close() {
            // No-op — relay manages client disconnect
          },
        };
        const connId = addConnection(virtualWs, device.id, true);
        linkClient(f.clientId, connId);
        sendToRelay({ type: "auth_response", clientId: f.clientId, allowed: true });
        console.log(`[Relay] Client ${f.clientId} authenticated as device ${device.name}`);

        pushInitialState(f.clientId);
      } else {
        sendToRelay({
          type: "auth_response",
          clientId: f.clientId,
          allowed: false,
          reason: "Invalid device token",
        });
        console.log(`[Relay] Client ${f.clientId} auth rejected`);
      }
    })
    .with({ type: "client_disconnected" }, (f) => {
      const connId = unlinkClient(f.clientId);
      if (connId) {
        removeQuerySubs(connId);
        clientWatches.delete(connId);
        stopWatcherIfEmpty();
        removeConnection(connId);
        console.log(`[Relay] Client ${f.clientId} disconnected`);
      }
    })
    .with({ type: "data" }, (f) => {
      const connId = clientToConn.get(f.clientId);
      if (!connId) return;
      if (!getConnection(connId)) return;

      try {
        const msg = JSON.parse(f.payload) as Record<string, unknown>;
        // Unified protocol handler — same as local WS clients
        handleProtocolMessage(connId, msg);
      } catch {
        // Ignore malformed inner messages
      }
    })
    .with({ type: "pair_request" }, (f) => {
      handlePairRequest(f.pairId, f.code, f.deviceName);
    })
    .with({ type: "ping" }, () => {
      sendToRelay({ type: "pong" });
    })
    .with({ type: "error" }, (f) => {
      console.error(`[Relay] Error from relay: ${f.message}`);
    })
    .exhaustive();
}

// ---- Pairing ----

function handlePairRequest(pairId: string, code: string, deviceName: string): void {
  if (!validatePairCode(code)) {
    sendToRelay({ type: "pair_response", pairId, success: false, reason: "Invalid or expired pairing code" });
    console.log(`[Relay] Pair request ${pairId} rejected: invalid code`);
    return;
  }

  const { token } = createDeviceToken(deviceName || "Web Portal", null, "relay-paired");
  sendToRelay({ type: "pair_response", pairId, success: true, deviceToken: token });
  console.log(`[Relay] Pair request ${pairId} succeeded, device "${deviceName}" paired`);
}

function pushInitialState(clientId: string): void {
  try {
    const db = getDatabase();
    const workspaces = getDashboardWorkspaces(db);
    const stats = getStats(db);

    sendToRelay({
      type: "data",
      clientId,
      payload: JSON.stringify({ type: "initial_state", workspaces, stats, serverName: getServerName() }),
    });
    console.log(`[Relay] Pushed initial state to client ${clientId}: ${workspaces.length} workspaces`);
  } catch (err) {
    console.error("[Relay] Failed to push initial state:", err);
  }
}

// ---- Data Requests ----
// Handles on-demand data requests from any authenticated connection.
// Sends responses via conn.ws.send() — works for both local and relay clients.

function handleDataRequest(connectionId: string, msg: Record<string, unknown>): void {
  try {
    const db = getDatabase();
    const resource = msg.resource as string;
    const requestId = msg.requestId as string | undefined;

    const data = match(resource)
      .with("workspaces", () => getDashboardWorkspaces(db))
      .with("stats", () => getStats(db))
      .with("sessions", () => {
        const workspaceId = msg.workspaceId as string;
        if (!workspaceId) return null;
        return db.prepare(`
          SELECT id, workspace_id, agent_type, title, status, model,
                 message_count, last_user_message_at, updated_at
          FROM sessions
          WHERE workspace_id = ?
          ORDER BY updated_at DESC
        `).all(workspaceId);
      })
      .with("messages", () => {
        const sessionId = msg.sessionId as string;
        if (!sessionId) return null;
        const limit = (msg.limit as number) || 50;
        return db.prepare(`
          SELECT id, session_id, seq, role, content, sent_at, model
          FROM messages
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?
        `).all(sessionId, limit).reverse();
      })
      .otherwise(() => null);

    sendToConnection(connectionId, { type: "response", resource, requestId, data });
  } catch (err) {
    console.error(`[Relay] Failed to handle data request:`, err);
  }
}

// ---- Send Message ----
// Saves user message to DB and broadcasts. Does NOT dispatch to sidecar —
// the sidecar is only reachable via Unix socket from Rust. Agent dispatch
// from relay clients is a follow-up (requires backend → sidecar channel).

function handleSendMessage(connectionId: string, msg: Record<string, unknown>): void {
  const sessionId = msg.sessionId as string | undefined;
  const content = msg.content as string | undefined;
  const model = msg.model as string | undefined;
  const requestId = msg.requestId as string | undefined;

  if (!sessionId || !content) {
    sendToConnection(connectionId, {
      type: "send_message_response",
      requestId,
      success: false,
      error: "sessionId and content are required",
    });
    return;
  }

  try {
    const result = writeUserMessage(sessionId, content, model);
    sendToConnection(connectionId, {
      type: "send_message_response",
      requestId,
      ...result,
    });
  } catch (err) {
    console.error("[Relay] send_message failed:", err);
    sendToConnection(connectionId, {
      type: "send_message_response",
      requestId,
      success: false,
      error: "Internal error",
    });
  }
}

/**
 * Persist a user message and mark session as working.
 * Shared write logic — same transaction as POST /sessions/:id/messages.
 */
export function writeUserMessage(
  sessionId: string,
  content: string,
  model?: string,
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
    db.prepare(`
      INSERT INTO messages (id, session_id, role, content, sent_at, model)
      VALUES (?, ?, 'user', ?, ?, ?)
    `).run(messageId, sessionId, content, sentAt, messageModel);

    db.prepare(
      "UPDATE sessions SET status = 'working', last_user_message_at = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(sentAt, sessionId);
  })();

  broadcastWorkspacesAndStats();
  invalidate(["workspaces", "sessions", "messages"]);

  return { success: true, messageId };
}

// ---- Session Watcher ----
// Pushes message deltas to any watching client (local WS or relay).
// Sends via conn.ws.send() — the WsSendable abstraction handles routing.

function handleWatchSession(connectionId: string, sessionId: string | null): void {
  if (!sessionId) {
    clientWatches.delete(connectionId);
    stopWatcherIfEmpty();
    return;
  }

  try {
    const db = getDatabase();
    const row = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE session_id = ?"
    ).get(sessionId) as { max_seq: number } | undefined;

    clientWatches.set(connectionId, {
      sessionId,
      lastSeq: row?.max_seq ?? 0,
    });
    startWatcher();
  } catch (err) {
    console.error("[Relay] Failed to start session watch:", err);
  }
}

function startWatcher(): void {
  if (watcherInterval) return;
  watcherInterval = setInterval(tickWatcher, WATCHER_POLL_MS);
}

function stopWatcherIfEmpty(): void {
  if (clientWatches.size === 0 && watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}

function tickWatcher(): void {
  if (clientWatches.size === 0) return;

  // Group watchers by sessionId
  const sessionGroups = new Map<string, Array<{ connectionId: string; lastSeq: number }>>();
  for (const [connectionId, watch] of clientWatches) {
    if (!getConnection(connectionId)) {
      clientWatches.delete(connectionId);
      continue;
    }
    let group = sessionGroups.get(watch.sessionId);
    if (!group) {
      group = [];
      sessionGroups.set(watch.sessionId, group);
    }
    group.push({ connectionId, lastSeq: watch.lastSeq });
  }

  stopWatcherIfEmpty();
  if (sessionGroups.size === 0) return;

  try {
    const db = getDatabase();

    for (const [sessionId, watchers] of sessionGroups) {
      const minSeq = Math.min(...watchers.map((w) => w.lastSeq));

      const newMessages = db.prepare(`
        SELECT id, session_id, seq, role, content, sent_at, model
        FROM messages
        WHERE session_id = ? AND seq > ?
        ORDER BY seq ASC
      `).all(sessionId, minSeq) as Array<{ seq: number; [key: string]: unknown }>;

      if (newMessages.length === 0) continue;

      const maxSeq = newMessages[newMessages.length - 1].seq;

      for (const watcher of watchers) {
        const clientMessages = watcher.lastSeq < minSeq
          ? newMessages
          : newMessages.filter((m) => m.seq > watcher.lastSeq);

        if (clientMessages.length === 0) continue;

        // Send via WsSendable — works for both local WS and relay virtual connections
        sendToConnection(watcher.connectionId, {
          type: "session_messages_delta",
          sessionId,
          messages: clientMessages,
        });

        const watchState = clientWatches.get(watcher.connectionId);
        if (watchState) watchState.lastSeq = maxSeq;
      }
    }
  } catch (err) {
    console.error("[Relay] Watcher tick error:", err);
  }
}

// ---- Helpers ----

/** Send a JSON message to a specific connection via WsSendable. */
function sendToConnection(connectionId: string, payload: Record<string, unknown>): void {
  const conn = getConnection(connectionId);
  if (!conn) return;
  try {
    conn.ws.send(JSON.stringify(payload));
  } catch {
    // Connection may have closed
  }
}

function sendToRelay(frame: ServerFrame): void {
  if (tunnelWs?.readyState === WebSocket.OPEN) {
    try {
      tunnelWs.send(JSON.stringify(frame));
    } catch {
      // Will be handled by close/error handlers
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY);
  reconnectAttempt++;
  console.log(`[Relay] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openTunnel();
  }, delay);
}
