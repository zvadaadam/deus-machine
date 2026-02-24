// backend/src/services/relay.service.ts
// Manages the outbound WebSocket tunnel to the cloud relay.
// Creates virtual WsConnections in ws.service for relay-forwarded clients.

import { WebSocket } from "ws";
import { match } from "ts-pattern";
import type { ServerFrame, RelayFrame } from "../../../shared/types/relay";
import {
  addConnection,
  removeConnection,
  getConnection,
  recordPong,
  addSubscriptions,
  removeSubscriptions,
  type WsSendable,
} from "./ws.service";
import { validateDeviceToken } from "./auth.service";
import { getDatabase } from "../lib/database";

// ---- State ----

let tunnelWs: WebSocket | null = null;
let relayUrl: string | null = null;
let serverId: string | null = null;
let relayToken: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

// Maps relay clientId → ws.service connectionId
const clientMap = new Map<string, string>();

// Server-side session watcher: pushes new messages to clients as they appear in the DB.
// Tracks per-client watched sessionId and last seen message seq to compute deltas.
interface SessionWatch {
  sessionId: string;
  lastSeq: number; // highest seq we've pushed to this client
}
const clientWatches = new Map<string, SessionWatch>(); // connectionId → watch state
let watcherInterval: ReturnType<typeof setInterval> | null = null;
const WATCHER_POLL_MS = 1_000; // 1s server-side check — one query covers all watchers

const MAX_RECONNECT_DELAY = 30_000;
const BASE_RECONNECT_DELAY = 1_000;

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
  // Clean up all virtual connections
  for (const [, connId] of clientMap) {
    removeConnection(connId);
  }
  clientMap.clear();
}

export function getRelayStatus(): { connected: boolean; clients: number; serverId: string | null; relayUrl: string | null } {
  return {
    connected: tunnelWs?.readyState === WebSocket.OPEN,
    clients: clientMap.size,
    serverId,
    relayUrl,
  };
}

// ---- Internal ----

function openTunnel(): void {
  if (!relayUrl || !serverId || !relayToken) return;

  const wsUrl = `${relayUrl}/api/servers/${serverId}/tunnel`;
  console.log(`[Relay] Connecting to ${wsUrl}...`);

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
    sendToRelay({ type: "register", serverId: serverId!, relayToken: relayToken! });
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
    // Clean up all virtual connections and watches on tunnel close
    for (const [, connId] of clientMap) {
      clientWatches.delete(connId);
      removeConnection(connId);
    }
    clientMap.clear();
    stopWatcherIfEmpty();
    // Reconnect if we still want to be connected
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
      // Validate device token locally
      const device = validateDeviceToken(f.deviceToken);
      if (device) {
        // Create a virtual WsConnection that sends data back through the relay tunnel
        const virtualWs: WsSendable = {
          send(data: string | ArrayBuffer) {
            const payload = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
            sendToRelay({ type: "data", clientId: f.clientId, payload });
          },
          close(_code?: number, _reason?: string) {
            // Client disconnect is handled by the relay — no-op here
          },
        };
        const connId = addConnection(virtualWs, device.id, true);
        clientMap.set(f.clientId, connId);
        sendToRelay({ type: "auth_response", clientId: f.clientId, allowed: true });
        console.log(`[Relay] Client ${f.clientId} authenticated as device ${device.name}`);

        // Push initial state snapshot to the newly connected client
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
      const connId = clientMap.get(f.clientId);
      if (connId) {
        clientWatches.delete(connId);
        stopWatcherIfEmpty();
        removeConnection(connId);
        clientMap.delete(f.clientId);
        console.log(`[Relay] Client ${f.clientId} disconnected`);
      }
    })
    .with({ type: "data" }, (f) => {
      // Forward data from relay client to the virtual WsConnection's message handler
      const connId = clientMap.get(f.clientId);
      if (!connId) return;
      const conn = getConnection(connId);
      if (!conn) return;

      // Parse and handle the inner WS protocol message
      try {
        const msg = JSON.parse(f.payload) as Record<string, unknown>;
        handleVirtualClientMessage(connId, msg);
      } catch {
        // Ignore malformed inner messages
      }
    })
    .with({ type: "ping" }, () => {
      sendToRelay({ type: "pong" });
    })
    .with({ type: "error" }, (f) => {
      console.error(`[Relay] Error from relay: ${f.message}`);
    })
    .exhaustive();
}

/**
 * Push an initial state snapshot (workspaces + stats) to a newly-authenticated relay client.
 * Uses inline SQL against the real app DB schema (repositories, workspaces, sessions, messages).
 */
function pushInitialState(clientId: string): void {
  try {
    const db = getDatabase();

    const workspaces = db.prepare(`
      SELECT
        w.id, w.slug, w.title,
        w.git_branch, w.git_target_branch,
        w.state, w.current_session_id,
        w.pr_url, w.pr_number, w.setup_status, w.error_message,
        w.updated_at,
        r.name as repo_name, r.root_path, r.git_default_branch,
        s.status as session_status, s.model,
        s.last_user_message_at as latest_message_sent_at
      FROM workspaces w
      LEFT JOIN repositories r ON w.repository_id = r.id
      LEFT JOIN sessions s ON w.current_session_id = s.id
      WHERE w.state != 'archived'
      ORDER BY r.sort_order ASC, r.name ASC, w.updated_at DESC
    `).all();

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM workspaces) as workspaces,
        (SELECT COUNT(*) FROM workspaces WHERE state = 'ready') as workspaces_ready,
        (SELECT COUNT(*) FROM workspaces WHERE state = 'archived') as workspaces_archived,
        (SELECT COUNT(*) FROM repositories) as repos,
        (SELECT COUNT(*) FROM sessions) as sessions,
        (SELECT COUNT(*) FROM sessions WHERE status = 'idle') as sessions_idle,
        (SELECT COUNT(*) FROM sessions WHERE status = 'working') as sessions_working,
        (SELECT COUNT(*) FROM messages) as messages
    `).get();

    sendToRelay({
      type: "data",
      clientId,
      payload: JSON.stringify({ type: "initial_state", workspaces, stats }),
    });
    console.log(`[Relay] Pushed initial state to client ${clientId}: ${(workspaces as unknown[]).length} workspaces`);
  } catch (err) {
    console.error("[Relay] Failed to push initial state:", err);
  }
}

/**
 * Handle inner WS protocol messages from relay-connected clients.
 * Same logic as the onMessage handler in app.ts, but for virtual connections.
 */
function handleVirtualClientMessage(connectionId: string, msg: Record<string, unknown>): void {
  match(msg.type as string)
    .with("pong", () => {
      recordPong(connectionId);
    })
    .with("subscribe", () => {
      if (Array.isArray(msg.topics)) {
        addSubscriptions(connectionId, msg.topics as string[]);
      }
    })
    .with("unsubscribe", () => {
      if (Array.isArray(msg.topics)) {
        removeSubscriptions(connectionId, msg.topics as string[]);
      }
    })
    .with("request", () => {
      handleDataRequest(connectionId, msg);
    })
    .with("watch_session", () => {
      handleWatchSession(connectionId, msg.sessionId as string | null);
    })
    .otherwise(() => {
      // Unknown message type — ignore
    });
}

/**
 * Handle on-demand data requests from relay-connected web clients.
 * Uses inline SQL against the real app DB schema (repositories, workspaces, sessions, messages).
 */
function handleDataRequest(connectionId: string, msg: Record<string, unknown>): void {
  let relayClientId: string | null = null;
  for (const [cId, connId] of clientMap) {
    if (connId === connectionId) {
      relayClientId = cId;
      break;
    }
  }
  if (!relayClientId) return;

  try {
    const db = getDatabase();
    const resource = msg.resource as string;
    const requestId = msg.requestId as string | undefined;

    const data = match(resource)
      .with("workspaces", () =>
        db.prepare(`
          SELECT
            w.id, w.slug, w.title,
            w.git_branch, w.state,
            r.name as repo_name,
            s.status as session_status, s.model,
            s.last_user_message_at as latest_message_sent_at,
            w.updated_at
          FROM workspaces w
          LEFT JOIN repositories r ON w.repository_id = r.id
          LEFT JOIN sessions s ON w.current_session_id = s.id
          WHERE w.state != 'archived'
          ORDER BY r.sort_order ASC, r.name ASC, w.updated_at DESC
        `).all()
      )
      .with("stats", () =>
        db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM workspaces) as workspaces,
            (SELECT COUNT(*) FROM workspaces WHERE state = 'ready') as workspaces_ready,
            (SELECT COUNT(*) FROM workspaces WHERE state = 'archived') as workspaces_archived,
            (SELECT COUNT(*) FROM repositories) as repos,
            (SELECT COUNT(*) FROM sessions) as sessions,
            (SELECT COUNT(*) FROM sessions WHERE status = 'idle') as sessions_idle,
            (SELECT COUNT(*) FROM sessions WHERE status = 'working') as sessions_working,
            (SELECT COUNT(*) FROM messages) as messages
        `).get()
      )
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

    sendToRelay({
      type: "data",
      clientId: relayClientId,
      payload: JSON.stringify({ type: "response", resource, requestId, data }),
    });
  } catch (err) {
    console.error(`[Relay] Failed to handle data request:`, err);
  }
}

// ---- Server-side session watcher ----
// Instead of clients polling for messages, the backend watches the DB
// and pushes only new messages (delta) to each watching client.

/**
 * Client wants to watch a session for live message updates.
 * Pass sessionId=null to stop watching.
 */
function handleWatchSession(connectionId: string, sessionId: string | null): void {
  if (!sessionId) {
    clientWatches.delete(connectionId);
    console.log(`[Relay] Client ${connectionId} stopped watching`);
    stopWatcherIfEmpty();
    return;
  }

  // Start watching: seed lastSeq from current max seq in DB so we only push NEW messages
  try {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE session_id = ?
    `).get(sessionId) as { max_seq: number } | undefined;

    clientWatches.set(connectionId, {
      sessionId,
      lastSeq: row?.max_seq ?? 0,
    });
    console.log(`[Relay] Client ${connectionId} watching session ${sessionId} from seq ${row?.max_seq ?? 0}`);
    startWatcher();
  } catch (err) {
    console.error("[Relay] Failed to start session watch:", err);
  }
}

/** Start the 1s interval if not already running. */
function startWatcher(): void {
  if (watcherInterval) return;
  watcherInterval = setInterval(tickWatcher, WATCHER_POLL_MS);
}

/** Stop the interval when no clients are watching. */
function stopWatcherIfEmpty(): void {
  if (clientWatches.size === 0 && watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}

/**
 * One tick of the watcher: for each unique watched session,
 * query new messages since lastSeq and push to watching clients.
 * Groups by session so one query serves all clients watching the same session.
 */
function tickWatcher(): void {
  if (clientWatches.size === 0) return;

  // Group watchers by sessionId → { connectionIds, minLastSeq }
  const sessionGroups = new Map<string, { watchers: Array<{ connectionId: string; lastSeq: number }> }>();
  for (const [connectionId, watch] of clientWatches) {
    // Verify connection still exists
    if (!getConnection(connectionId)) {
      clientWatches.delete(connectionId);
      continue;
    }
    let group = sessionGroups.get(watch.sessionId);
    if (!group) {
      group = { watchers: [] };
      sessionGroups.set(watch.sessionId, group);
    }
    group.watchers.push({ connectionId, lastSeq: watch.lastSeq });
  }

  stopWatcherIfEmpty();
  if (sessionGroups.size === 0) return;

  try {
    const db = getDatabase();

    for (const [sessionId, group] of sessionGroups) {
      // Find the minimum lastSeq among all watchers for this session
      const minSeq = Math.min(...group.watchers.map((w) => w.lastSeq));

      const newMessages = db.prepare(`
        SELECT id, session_id, seq, role, content, sent_at, model
        FROM messages
        WHERE session_id = ? AND seq > ?
        ORDER BY seq ASC
      `).all(sessionId, minSeq) as Array<{ seq: number; [key: string]: unknown }>;

      if (newMessages.length === 0) continue;

      const maxSeq = newMessages[newMessages.length - 1].seq;

      // Push to each watcher — filter per-client to only send messages they haven't seen
      for (const watcher of group.watchers) {
        const clientMessages = watcher.lastSeq < minSeq
          ? newMessages
          : newMessages.filter((m) => m.seq > watcher.lastSeq);

        if (clientMessages.length === 0) continue;

        // Find relay clientId for this connectionId
        let relayClientId: string | null = null;
        for (const [cId, connId] of clientMap) {
          if (connId === watcher.connectionId) {
            relayClientId = cId;
            break;
          }
        }
        if (!relayClientId) continue;

        sendToRelay({
          type: "data",
          clientId: relayClientId,
          payload: JSON.stringify({
            type: "session_messages_delta",
            sessionId,
            messages: clientMessages,
          }),
        });

        // Update lastSeq for this watcher
        const watchState = clientWatches.get(watcher.connectionId);
        if (watchState) watchState.lastSeq = maxSeq;
      }
    }
  } catch (err) {
    console.error("[Relay] Watcher tick error:", err);
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
