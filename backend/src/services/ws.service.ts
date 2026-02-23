// backend/src/services/ws.service.ts
// WebSocket connection manager for remote access.
// Manages connected clients, heartbeat pings, and message routing.

import type { WSContext } from "hono/ws";

/** Minimal interface for sending/closing WebSocket-like connections.
 *  WSContext already satisfies this — used to also accept virtual relay connections. */
export interface WsSendable {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface WsConnection {
  id: string;
  ws: WsSendable;
  deviceId: string | null;
  subscriptions: Set<string>;
  lastPong: number;
  /** True for relay-tunneled connections (skip direct heartbeat pings) */
  isVirtual?: boolean;
}

// ---- State ----

const connections = new Map<string, WsConnection>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

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
    subscriptions: new Set(),
    lastPong: Date.now(),
    isVirtual,
  });

  startHeartbeat();
  return id;
}

/** Remove a connection by ID. */
export function removeConnection(id: string): void {
  connections.delete(id);
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
export function broadcast(message: string): void {
  for (const conn of connections.values()) {
    try {
      conn.ws.send(message);
    } catch {
      // Connection may have closed — will be cleaned up on next heartbeat
    }
  }
}

/** Broadcast a message to connections subscribed to a specific topic. */
export function broadcastToSubscribers(topic: string, message: string): void {
  for (const conn of connections.values()) {
    if (conn.subscriptions.has(topic)) {
      try {
        conn.ws.send(message);
      } catch {
        // Will be cleaned up on next heartbeat
      }
    }
  }
}

/** Add subscription topics to a connection. */
export function addSubscriptions(id: string, topics: string[]): void {
  const conn = connections.get(id);
  if (conn) {
    for (const topic of topics) conn.subscriptions.add(topic);
  }
}

/** Remove subscription topics from a connection. */
export function removeSubscriptions(id: string, topics: string[]): void {
  const conn = connections.get(id);
  if (conn) {
    for (const topic of topics) conn.subscriptions.delete(topic);
  }
}

/** Get number of active connections. */
export function getConnectionCount(): number {
  return connections.size;
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
  connections.clear();
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
      connections.delete(id);
      continue;
    }

    // Send ping
    try {
      conn.ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      connections.delete(id);
    }
  }

  if (connections.size === 0) stopHeartbeat();
}
