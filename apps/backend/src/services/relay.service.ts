// backend/src/services/relay.service.ts
// Manages the outbound WebSocket tunnel to the cloud relay.
// Creates virtual WsConnections in ws.service for relay-forwarded clients.
// Registers the query-engine protocol handler for q:* frames.

import { execSync } from "child_process";
import { hostname, userInfo, platform } from "os";
import { WebSocket } from "ws";
import { match } from "ts-pattern";
import type { ServerFrame, RelayFrame } from "@shared/types/relay";
import { getSetting } from "./settings.service";
import {
  getRelayCredentials,
  generateRelayCredentials,
  validateDeviceToken,
  authorizePairing,
  createDeviceToken,
  updateLastSeen,
} from "./remote-auth.service";
import { DEFAULT_RELAY_URL } from "../lib/network";
import {
  addConnection,
  removeConnection,
  getConnection,
  setProtocolHandlers,
  handleProtocolMessage,
  type WsSendable,
} from "./ws.service";
import { handleFrame as handleQueryFrame, removeSubs as removeQuerySubs } from "./query-engine";

// ---- Tunnel State ----

let tunnelWs: WebSocket | null = null;
let relayUrl: string | null = null;
let serverId: string | null = null;
let relayToken: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

// ---- Relay clients ----

const clientToConn = new Map<string, string>();

function unlinkClient(clientId: string): string | undefined {
  const connectionId = clientToConn.get(clientId);
  clientToConn.delete(clientId);
  return connectionId;
}

const MAX_RECONNECT_DELAY = 30_000;
const BASE_RECONNECT_DELAY = 1_000;

// ---- Server Name Detection ----

function getServerName(): string {
  const custom = getSetting("server_name") as string | undefined;
  if (custom) return custom;

  if (platform() === "darwin") {
    try {
      const name = execSync("scutil --get ComputerName", {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      if (name) return name;
    } catch {
      /* fall through */
    }
  }

  const host = hostname().replace(/\.local$/, "");
  if (host && host !== "localhost") return host;

  try {
    return `${userInfo().username}'s computer`;
  } catch {
    return "Deus Server";
  }
}

// ---- Protocol Handler ----
// Registered once at module load. Routes q:* frames to the query engine.

setProtocolHandlers({
  onQueryFrame: handleQueryFrame,
  onDisconnect: removeQuerySubs,
});

// ---- Public API ----

export function ensureRelayConnected(): void {
  const url = DEFAULT_RELAY_URL;
  let creds = getRelayCredentials();
  if (!creds) {
    creds = generateRelayCredentials();
  }
  // Already connected or connecting with same credentials — skip
  if (
    relayUrl === url &&
    serverId === creds.serverId &&
    relayToken === creds.relayToken &&
    tunnelWs &&
    (tunnelWs.readyState === WebSocket.OPEN || tunnelWs.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  connectToRelay(url, creds.serverId, creds.relayToken);
}

function connectToRelay(url: string, id: string, token: string): void {
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
    removeConnection(connId);
  }
  clientToConn.clear();
}

export function getRelayStatus(): {
  connected: boolean;
  clients: number;
  serverId: string | null;
  relayUrl: string | null;
} {
  const effectiveUrl = relayUrl ?? DEFAULT_RELAY_URL;
  const creds = serverId ? null : getRelayCredentials();
  const effectiveServerId = serverId ?? creds?.serverId ?? null;

  return {
    connected: tunnelWs?.readyState === WebSocket.OPEN,
    clients: clientToConn.size,
    serverId: effectiveServerId,
    relayUrl: effectiveUrl,
  };
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
    sendToRelay({
      type: "register",
      serverId: serverId!,
      relayToken: relayToken!,
      serverName: getServerName(),
    });
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
      removeConnection(connId);
    }
    clientToConn.clear();
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
          removeConnection(existingConnId);
        }

        // Virtual WsSendable routes data back through the relay tunnel
        const virtualWs: WsSendable = {
          send(data: string | ArrayBuffer) {
            const payload =
              typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
            sendToRelay({ type: "data", clientId: f.clientId, payload });
          },
          close(_code, reason) {
            unlinkClient(f.clientId);
            sendToRelay({
              type: "auth_response",
              clientId: f.clientId,
              allowed: false,
              reason,
            });
          },
        };
        const connId = addConnection(virtualWs, device.id, true);
        clientToConn.set(f.clientId, connId);
        updateLastSeen(device.token_hash);
        sendToRelay({ type: "auth_response", clientId: f.clientId, allowed: true });
        console.log(`[Relay] Client ${f.clientId} authenticated as device ${device.name}`);
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
  // The relay supplies no trustworthy client IP; redialing must not reset this budget.
  const error = authorizePairing(code, "relay");
  if (error) {
    sendToRelay({
      type: "pair_response",
      pairId,
      success: false,
      reason:
        error === "rate_limited"
          ? "Too many failed attempts. Try again later."
          : "Invalid or expired pairing code",
    });
    console.log(`[Relay] Pair request ${pairId} rejected: ${error}`);
    return;
  }

  const { token } = createDeviceToken(deviceName || "Web Portal", null, "relay-paired");
  sendToRelay({ type: "pair_response", pairId, success: true, deviceToken: token });
  console.log(`[Relay] Pair request ${pairId} succeeded, device "${deviceName}" paired`);
}

// ---- Helpers ----

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
