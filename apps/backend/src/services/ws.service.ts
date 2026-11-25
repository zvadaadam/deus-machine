// backend/src/services/ws.service.ts
// WebSocket connection manager for remote access.
// Manages connected clients, heartbeat pings, message routing, and protocol dispatch.

import { match } from "ts-pattern";
import type { QServerFrame } from "@shared/types/query-protocol";
import type { AdmittedAssistant } from "../api/registry";

/** Minimal interface for sending/closing WebSocket-like connections.
 *  WSContext already satisfies this — used to also accept virtual relay connections. */
export interface WsSendable {
  /** A transport may throw FrameTooLarge before sending any bytes. */
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface WsConnection {
  id: string;
  ws: WsSendable;
  deviceId: string | null;
  /** When the client was last heard from: a pong, or any frame it sent. */
  lastPong: number;
  /** True for relay-tunneled connections (skip direct heartbeat pings) */
  isVirtual?: boolean;
  /**
   * A hosted assistant that signed in with the account (never a paired
   * device: `deviceId` is null). Its access is fixed for the connection's
   * life: changing it closes the connection (`closeAssistantConnections`).
   */
  assistant?: AdmittedAssistant | null;
  /** An assistant's connection is closed by this timer, whatever its traffic. */
  endTimer?: ReturnType<typeof setTimeout>;
  /** Epoch ms the timer closes it: the sooner of its sign-in's end and the cap. */
  endsAt?: number;
}

/** An assistant let in: who it is, and when its sign-in ends (epoch ms, with the clock tolerance). */
export interface AssistantAdmission {
  assistant: AdmittedAssistant;
  signInEndsAt: number;
}

// ---- State ----

const connections = new Map<string, WsConnection>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let deviceListener: (() => void) | null = null;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
/** A relayed viewer probes every 30s (its runtime client's ping). Two missed
 *  probes and it is gone, whether or not the relay noticed. */
const VIRTUAL_SILENCE_MS = 2 * HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS;
/** The longest an assistant's connection lives, whatever its traffic. It
 *  carries one request and does not probe: Deus Cloud opens one per request,
 *  holds a call at most about 150s and closes it when it has the answer; this
 *  bounds one it never closed. It ends sooner when its sign-in does. */
const ASSISTANT_CONNECTION_MS = 200_000;

// ---- Public API ----

/** Register a new WebSocket connection. Returns the connection ID. */
export function addConnection(
  ws: WsSendable,
  deviceId: string | null,
  isVirtual = false,
  admission: AssistantAdmission | null = null
): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  const assistant = admission?.assistant ?? null;
  const conn: WsConnection = { id, ws, deviceId, lastPong: now, isVirtual, assistant };
  connections.set(id, conn);
  if (admission) {
    // Neither a ping nor a request extends it: the end is fixed when it opens.
    const end = Math.min(admission.signInEndsAt, now + ASSISTANT_CONNECTION_MS);
    conn.endsAt = end;
    conn.endTimer = setTimeout(
      () =>
        closeConnection(
          conn,
          4001,
          end - now < ASSISTANT_CONNECTION_MS
            ? "Assistant sign-in expired"
            : "Assistant connection ended"
        ),
      Math.max(0, end - now)
    );
    conn.endTimer.unref?.();
  }

  startHeartbeat();
  if (deviceId) deviceListener?.();
  return id;
}

/** Remove a connection by ID. */
export function removeConnection(id: string): void {
  const conn = connections.get(id);
  if (!conn) return;
  connections.delete(id);
  if (conn.endTimer) clearTimeout(conn.endTimer);
  if (connections.size === 0) stopHeartbeat();
  extendedHandlers.onDisconnect?.(id);
  if (conn.deviceId) deviceListener?.();
}

/** Paired devices with a live connection (relay or local network). The desktop's own window has none. */
export function connectedDeviceIds(): Set<string> {
  const ids = new Set<string>();
  for (const conn of connections.values()) if (conn.deviceId) ids.add(conn.deviceId);
  return ids;
}

/** Called whenever a paired device connects or disconnects. */
export function onDeviceConnectionsChange(listener: (() => void) | null): void {
  deviceListener = listener;
}

function closeConnection(conn: WsConnection, code: number, reason: string): void {
  // Stop dispatch and subscriptions before the transport's close event arrives.
  removeConnection(conn.id);
  try {
    conn.ws.close(code, reason);
  } catch {
    // The connection is already removed even if its transport has gone away.
  }
}

/** Revoke every live connection belonging to a paired device. */
export function closeDeviceConnections(deviceId: string): void {
  for (const conn of connections.values()) {
    if (conn.deviceId === deviceId) closeConnection(conn, 4001, "Device access revoked");
  }
}

/** An assistant's access changed or it was removed: its connections end now, not at their next request. */
export function closeAssistantConnections(clientId: string): void {
  for (const conn of connections.values()) {
    if (conn.assistant?.clientId === clientId)
      closeConnection(conn, 4001, "Assistant access changed");
  }
}

/**
 * Remote access was turned off: disconnect the devices on the local network
 * (relayed ones go with the tunnel). Not a revocation: each keeps its approval
 * and reconnects once remote access is back on.
 */
export function disconnectDirectDevices(): void {
  for (const conn of connections.values()) {
    if (conn.deviceId && !conn.isVirtual) closeConnection(conn, 1001, "Remote access turned off");
  }
}

/** Get a connection by ID. */
export function getConnection(id: string): WsConnection | undefined {
  return connections.get(id);
}

/** A transport refused the encoded message before sending any bytes. */
export class FrameTooLarge extends Error {
  constructor(bytes: number) {
    super(`Frame is too large (${bytes} bytes)`);
  }
}

type ConnectionFrame =
  | QServerFrame
  | { type: "connected"; connectionId: string }
  | { type: "ping" }
  | { type: "pong"; id?: string };

/**
 * Sends one frame and reports a gone connection or a refusal by its transport.
 * The caller decides what to tell its peer when a frame is refused.
 */
export function sendFrame(
  connectionId: string,
  frame: ConnectionFrame
): "sent" | "too-large" | "unavailable" {
  const connection = connections.get(connectionId);
  if (!connection) return "unavailable";
  try {
    connection.ws.send(JSON.stringify(frame));
    return "sent";
  } catch (error) {
    return error instanceof FrameTooLarge ? "too-large" : "unavailable";
  }
}

/** Close all connections and stop heartbeat (for shutdown). */
export function closeAll(): void {
  stopHeartbeat();
  for (const conn of connections.values()) {
    closeConnection(conn, 1001, "Server shutting down");
  }
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
    // The relay tunnel carries a virtual connection's pings: the viewer probes
    // and this end answers (handleProtocolMessage). One whose probes stopped
    // (a half-open phone the relay never saw leave, a suspended tab) is
    // forgotten here, not closed: the relay's only way to close one viewer is
    // a denial, which revokes its grant. A viewer that comes back finds its
    // probes unanswered and reconnects with the same grant.
    if (conn.isVirtual) {
      // An assistant's connection ends by its own timer (`addConnection`).
      if (conn.assistant) continue;
      if (now - conn.lastPong > VIRTUAL_SILENCE_MS) {
        console.log(`[WS] Forgetting silent relay connection: ${id}`);
        removeConnection(id);
      }
      continue;
    }

    if (now - conn.lastPong > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS) {
      // Client hasn't responded to pings — close
      console.log(`[WS] Closing stale connection: ${id}`);
      closeConnection(conn, 1001, "Heartbeat timeout");
      continue;
    }

    if (sendFrame(id, { type: "ping" }) === "unavailable") {
      closeConnection(conn, 1001, "Connection lost");
    }
  }

  if (connections.size === 0) stopHeartbeat();
}

// ---- Protocol Dispatch ----

/** Query protocol dispatch and subscription cleanup. */
export interface WsProtocolHandlers {
  onQueryFrame?: (connectionId: string, msg: Record<string, unknown>) => void;
  onDisconnect?: (connectionId: string) => void;
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
 * Core: ping / pong
 * Query protocol: q:* frames routed to query engine
 */
export function handleProtocolMessage(connectionId: string, msg: Record<string, unknown>): void {
  const connection = connections.get(connectionId);
  if (!connection) return;
  connection.lastPong = Date.now();
  match(msg.type as string)
    .with("ping", () => {
      // Echo a client probe through the same authenticated path, including relay
      // virtual connections, so the client can detect a silent one-way failure.
      const id = typeof msg.id === "string" ? msg.id : undefined;
      if (sendFrame(connectionId, { type: "pong", id }) === "unavailable") {
        closeConnection(connection, 1001, "Connection lost");
      }
    })
    .otherwise(() => {
      // Route q:* frames to query engine handler
      if (typeof msg.type === "string" && msg.type.startsWith("q:")) {
        extendedHandlers.onQueryFrame?.(connectionId, msg);
      }
    });
}
