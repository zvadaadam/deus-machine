// backend/src/services/ws.service.ts
// WebSocket connection manager for remote access.
// Manages connected clients, heartbeat pings, message routing, and protocol dispatch.

import { match } from "ts-pattern";
import type { WSContext } from "hono/ws";

/** Minimal interface for sending/closing WebSocket-like connections.
 *  WSContext already satisfies this — used to also accept virtual relay connections. */
export interface WsSendable {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}

export interface WsConnection {
  id: string;
  ws: WsSendable;
  deviceId: string | null;
  lastPong: number;
  /** True for relay-tunneled connections (skip direct heartbeat pings) */
  isVirtual?: boolean;
}

// ---- State ----

const connections = new Map<string, WsConnection>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const connectionRemovedListeners = new Set<(connectionId: string) => void>();

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

// ---- Public API ----

/** Register a new WebSocket connection. Returns the connection ID. */
export function addConnection(ws: WsSendable, deviceId: string | null, isVirtual = false): string {
  const id = crypto.randomUUID();
  connections.set(id, {
    id,
    ws,
    deviceId,
    lastPong: Date.now(),
    isVirtual,
  });

  startHeartbeat();
  return id;
}

/** Remove a connection by ID. */
export function removeConnection(id: string): void {
  const existed = connections.delete(id);
  if (existed) notifyConnectionRemoved(id);
  if (connections.size === 0) stopHeartbeat();
}

/** Get a connection by ID. */
export function getConnection(id: string): WsConnection | undefined {
  return connections.get(id);
}

/** Record a pong from a client. */
export function recordPong(id: string): void {
  const conn = connections.get(id);
  if (conn) conn.lastPong = Date.now();
}

/** Broadcast a message to all connected clients. */
export function broadcast(message: string, options: { maxBufferedAmount?: number } = {}): void {
  for (const conn of connections.values()) {
    if (shouldDropForBackpressure(conn, options.maxBufferedAmount)) continue;
    try {
      conn.ws.send(message);
    } catch {
      // Connection may have closed — will be cleaned up on next heartbeat
    }
  }
}

/** Send a message to one connected client. */
export function sendToConnection(
  id: string,
  message: string,
  options: { maxBufferedAmount?: number } = {}
): boolean {
  const conn = connections.get(id);
  if (!conn || shouldDropForBackpressure(conn, options.maxBufferedAmount)) return false;
  try {
    conn.ws.send(message);
    return true;
  } catch {
    return false;
  }
}

export function onConnectionRemoved(listener: (connectionId: string) => void): () => void {
  connectionRemovedListeners.add(listener);
  return () => connectionRemovedListeners.delete(listener);
}

/** Close all connections and stop heartbeat (for shutdown). */
export function closeAll(): void {
  stopHeartbeat();
  for (const conn of connections.values()) {
    try {
      conn.ws.close(1001, "Server shutting down");
    } catch {
      // Best-effort
    }
  }
  const removedIds = [...connections.keys()];
  connections.clear();
  for (const id of removedIds) notifyConnectionRemoved(id);
}

// ---- Heartbeat ----

function startHeartbeat(): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(checkHeartbeats, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function checkHeartbeats(): void {
  const now = Date.now();
  for (const [id, conn] of connections) {
    // Virtual connections are managed by the relay tunnel — skip direct heartbeat
    if (conn.isVirtual) continue;

    if (now - conn.lastPong > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS) {
      // Client hasn't responded to pings — close
      console.log(`[WS] Closing stale connection: ${id}`);
      try {
        conn.ws.close(1001, "Heartbeat timeout");
      } catch {
        // Already closed
      }
      removeConnection(id);
      continue;
    }

    // Send ping
    try {
      conn.ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      removeConnection(id);
    }
  }

  if (connections.size === 0) stopHeartbeat();
}

function shouldDropForBackpressure(
  conn: WsConnection,
  maxBufferedAmount: number | undefined
): boolean {
  return maxBufferedAmount !== undefined && (conn.ws.bufferedAmount ?? 0) > maxBufferedAmount;
}

function notifyConnectionRemoved(connectionId: string): void {
  for (const listener of connectionRemovedListeners) {
    try {
      listener(connectionId);
    } catch {
      // Cleanup listeners should not break WS teardown.
    }
  }
}

// ---- Protocol Dispatch ----

/** Handlers for protocol frames beyond the core pong. */
export interface WsProtocolHandlers {
  onQueryFrame?: (connectionId: string, msg: Record<string, unknown>) => void;
}

let extendedHandlers: WsProtocolHandlers = {};

/** Register handlers for extended protocol messages. Called once at startup. */
export function setProtocolHandlers(handlers: WsProtocolHandlers): void {
  extendedHandlers = { ...extendedHandlers, ...handlers };
}

/**
 * Handle an incoming WS protocol message for an authenticated connection.
 * Shared by local WS (app.ts) and virtual relay connections (relay.service.ts).
 *
 * Core: pong
 * Query protocol: q:* frames routed to query engine
 */
export function handleProtocolMessage(connectionId: string, msg: Record<string, unknown>): void {
  match(msg.type as string)
    .with("pong", () => {
      recordPong(connectionId);
    })
    .otherwise(() => {
      // Route q:* frames to query engine handler
      if (typeof msg.type === "string" && msg.type.startsWith("q:")) {
        extendedHandlers.onQueryFrame?.(connectionId, msg);
      }
    });
}
