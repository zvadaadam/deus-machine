/**
 * WebSocket Query Protocol Client
 *
 * Singleton client that connects to the backend's /ws endpoint and handles
 * the q:* protocol for real-time data subscriptions. Used by the desktop
 * frontend to receive data pushes instead of HTTP polling.
 *
 * Protocol:
 *   Client sends: q:subscribe, q:unsubscribe
 *   Server sends: q:snapshot, q:delta, q:error, ping
 *   Client responds to ping with pong
 *
 * On reconnect, all active subscriptions are re-established automatically.
 */

import { match } from "ts-pattern";
import { getBackendPort } from "@/shared/config/api.config";
import type { QueryResource, CommandName } from "@shared/types/query-protocol";

// ---- Types ----

type SnapshotCallback = (data: unknown) => void;
type DeltaCallback = (upserted?: unknown[], removed?: string[], cursor?: number) => void;
type EventCallback = (event: string, data: unknown) => void;

interface PendingCommand {
  resolve: (result: { accepted: boolean; commandId?: string; error?: string }) => void;
  reject: (err: Error) => void;
}

interface Subscription {
  id: string;
  resource: QueryResource;
  params?: Record<string, unknown>;
  onSnapshot: SnapshotCallback;
  onDelta?: DeltaCallback;
}

// ---- Reconnect Config ----

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;

// ---- Singleton State ----

let ws: WebSocket | null = null;
let _connectionId: string | null = null;
let connected = false;
let connecting = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let subCounter = 0;

/** Active subscriptions keyed by client-assigned ID. */
const subscriptions = new Map<string, Subscription>();

/** Pending commands waiting for q:command_ack. */
const pendingCommands = new Map<string, PendingCommand>();

/** Listeners for q:event broadcasts. */
const eventListeners = new Set<EventCallback>();

/** Listeners notified when connection state changes (connected/disconnected). */
const connectionChangeListeners = new Set<(connected: boolean) => void>();

/** Counter for generating unique command frame IDs. */
let commandCounter = 0;

/** Resolvers waiting for the initial "connected" frame after open. */
let connectResolve: (() => void) | null = null;
let connectReject: ((err: Error) => void) | null = null;

// ---- Public API ----

/** Generate a unique subscription ID. */
function nextSubId(): string {
  return `sub_${++subCounter}`;
}

/**
 * Connect to the backend WebSocket. Resolves once authenticated.
 * No-op if already connected or connecting.
 */
export async function connect(): Promise<void> {
  if (connected) return;
  if (connecting) {
    // Wait for the in-flight connection attempt
    return new Promise<void>((resolve, reject) => {
      const prevResolve = connectResolve;
      const prevReject = connectReject;
      connectResolve = () => {
        prevResolve?.();
        resolve();
      };
      connectReject = (err) => {
        prevReject?.(err);
        reject(err);
      };
    });
  }

  connecting = true;

  return new Promise<void>((resolve, reject) => {
    connectResolve = resolve;
    connectReject = reject;
    openSocket().catch((err) => {
      connecting = false;
      connectReject?.(err);
      connectResolve = null;
      connectReject = null;
    });
  });
}

/**
 * Subscribe to a query resource. Returns an unsubscribe function.
 *
 * On subscription, the server sends an initial q:snapshot. Subsequent
 * invalidations push q:snapshot (full replace) or q:delta (incremental).
 */
export function subscribe(
  resource: QueryResource,
  params: Record<string, unknown> | undefined,
  onSnapshot: SnapshotCallback,
  onDelta?: DeltaCallback
): () => void {
  const id = nextSubId();
  const sub: Subscription = { id, resource, params, onSnapshot, onDelta };
  subscriptions.set(id, sub);

  // If connected, send subscribe frame immediately
  if (connected && ws) {
    sendFrame({
      type: "q:subscribe",
      id,
      resource,
      ...(params ? { params } : {}),
    });
  }

  // Return unsubscribe function
  return () => {
    subscriptions.delete(id);
    if (connected && ws) {
      sendFrame({ type: "q:unsubscribe", id });
    }
  };
}

/** Check if the client is currently connected. */
export function isConnected(): boolean {
  return connected;
}

/**
 * Send an async command via the q:command frame.
 * Used by upcoming cloud/relay feature -- no desktop consumer yet.
 * Returns a promise that resolves when the server sends q:command_ack.
 */
export function sendCommand(
  command: CommandName,
  params: Record<string, unknown>
): Promise<{ accepted: boolean; commandId?: string; error?: string }> {
  const id = `cmd_${++commandCounter}`;

  return new Promise((resolve, reject) => {
    pendingCommands.set(id, { resolve, reject });

    const sent = sendFrame({
      type: "q:command",
      id,
      command,
      params,
    });

    // Reject immediately if the frame couldn't be sent (WS disconnected)
    if (!sent) {
      pendingCommands.delete(id);
      reject(new Error("WebSocket not connected"));
      return;
    }

    // Timeout after 30s to prevent leaked promises
    setTimeout(() => {
      if (pendingCommands.has(id)) {
        pendingCommands.delete(id);
        reject(new Error(`Command ${command} timed out`));
      }
    }, 30_000);
  });
}

/**
 * Register a callback for q:event broadcasts.
 * Returns an unregister function.
 */
export function onEvent(callback: EventCallback): () => void {
  eventListeners.add(callback);
  return () => {
    eventListeners.delete(callback);
  };
}

/**
 * Send a tool response back to the backend (q:tool_response frame).
 * Used by frontend RPC handlers to respond to tool relay requests
 * received via q:event with event: "tool:request".
 */
export function sendToolResponse(requestId: string, result?: unknown, error?: string): boolean {
  const frame: Record<string, unknown> = {
    type: "q:tool_response",
    requestId,
  };
  if (error !== undefined) {
    frame.error = error;
  } else {
    frame.result = result;
  }
  return sendFrame(frame);
}

/**
 * Force an immediate reconnection to the backend.
 * Used when the backend restarts on a new port — cancels any pending
 * backoff timer and closes the stale socket so reconnection picks up
 * the new port from getBackendPort().
 */
export function forceReconnect(): void {
  // Cancel any pending reconnect timer so we don't double-connect
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Reset backoff counter so the immediate attempt uses minimal delay
  reconnectAttempt = 0;

  // Close existing socket (if open) — onclose handler will NOT auto-schedule
  // because we immediately trigger our own reconnect below.
  if (ws) {
    // Prevent the onclose handler from scheduling its own reconnect
    const staleWs = ws;
    ws = null;
    connected = false;
    connecting = false;
    _connectionId = null;
    staleWs.onclose = null;
    staleWs.close();

    notifyConnectionChange(false);
  }

  // Immediately open a new socket (reads fresh port from getBackendPort())
  connecting = true;
  openSocket().catch(() => {
    connecting = false;
    // If this fails, fall back to normal backoff reconnect
    scheduleReconnect();
  });
}

/**
 * Register a callback for connection state changes.
 * Fires with `true` when connected, `false` when disconnected.
 * Used by useQuerySubscription to re-evaluate subscriptions after reconnect.
 * Returns an unregister function.
 */
export function onConnectionChange(callback: (connected: boolean) => void): () => void {
  connectionChangeListeners.add(callback);
  return () => {
    connectionChangeListeners.delete(callback);
  };
}

// ---- Internal ----

async function openSocket(): Promise<void> {
  const port = await getBackendPort();
  const url = `ws://localhost:${port}/ws`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    // Localhost connections are auto-authenticated by the backend.
    // Wait for the "connected" frame in onmessage.
  };

  ws.onmessage = (evt) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(evt.data as string);
    } catch {
      return;
    }

    const type = typeof msg.type === "string" ? msg.type : "";

    match(type)
      .with("connected", () => {
        _connectionId = msg.connectionId as string;
        connected = true;
        connecting = false;
        reconnectAttempt = 0;

        // Re-subscribe all active subscriptions (reconnect scenario)
        resubscribeAll();

        // Notify hooks that connection is available so they can set up subscriptions
        notifyConnectionChange(true);

        connectResolve?.();
        connectResolve = null;
        connectReject = null;
      })
      .with("ping", () => {
        sendFrame({ type: "pong" });
      })
      .with("q:snapshot", () => {
        const sub = subscriptions.get(msg.id as string);
        sub?.onSnapshot(msg.data);
      })
      .with("q:delta", () => {
        const sub = subscriptions.get(msg.id as string);
        sub?.onDelta?.(
          msg.upserted as unknown[] | undefined,
          msg.removed as string[] | undefined,
          msg.cursor as number | undefined
        );
      })
      .with("q:command_ack", () => {
        const pending = pendingCommands.get(msg.id as string);
        if (pending) {
          pendingCommands.delete(msg.id as string);
          pending.resolve({
            accepted: msg.accepted as boolean,
            commandId: msg.commandId as string | undefined,
            error: msg.error as string | undefined,
          });
        }
      })
      .with("q:event", () => {
        const event = msg.event as string;
        const data = msg.data;
        for (const cb of eventListeners) {
          try {
            cb(event, data);
          } catch (err) {
            console.error("[WS] Event listener error:", err);
          }
        }
      })
      .with("q:error", () => {
        console.warn("[WS] Query error:", msg.message, "for sub:", msg.id);
      })
      .otherwise(() => {
        // Ignore unknown frame types (q:response, q:mutate_result, etc.)
      });
  };

  ws.onerror = () => {
    // onerror fires before onclose — actual cleanup happens in onclose
  };

  ws.onclose = () => {
    const wasConnected = connected;
    connected = false;
    _connectionId = null;
    ws = null;

    // Reject all pending commands immediately — they can't succeed without a connection
    for (const [_id, pending] of pendingCommands) {
      pending.reject(new Error("WebSocket disconnected"));
    }
    pendingCommands.clear();

    if (connecting) {
      // Initial connection failed — reject the connect() promise
      connecting = false;
      connectReject?.(new Error("WebSocket connection failed"));
      connectResolve = null;
      connectReject = null;
    }

    if (wasConnected) {
      notifyConnectionChange(false);
    }

    // Only auto-reconnect if we had previously connected or have active subscriptions
    if (wasConnected || subscriptions.size > 0) {
      scheduleReconnect();
    }
  };
}

/** Notify all connection change listeners. */
function notifyConnectionChange(state: boolean): void {
  for (const cb of connectionChangeListeners) {
    try {
      cb(state);
    } catch (err) {
      console.error("[WS] Connection change listener error:", err);
    }
  }
}

function sendFrame(frame: Record<string, unknown>): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      // Connection may have closed between readyState check and send
      console.warn(`[WS] Failed to send ${frame.type} frame: connection closed during send`);
      return false;
    }
  }
  console.warn(`[WS] Dropped ${frame.type} frame: WebSocket not connected`);
  return false;
}

/** Re-subscribe all active subscriptions after reconnect. */
function resubscribeAll(): void {
  for (const sub of subscriptions.values()) {
    sendFrame({
      type: "q:subscribe",
      id: sub.id,
      resource: sub.resource,
      ...(sub.params ? { params: sub.params } : {}),
    });
  }
}

/** Schedule a reconnection with exponential backoff. */
function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, reconnectAttempt), BACKOFF_MAX_MS);
  reconnectAttempt++;

  if (import.meta.env.DEV) {
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connecting = true;

    // Set up resolve/reject so subscriptions get re-established
    connectResolve = null;
    connectReject = null;

    openSocket().catch(() => {
      connecting = false;
      // onclose handler will schedule another reconnect
    });
  }, delay);
}
