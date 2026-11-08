// backend/src/services/relay.service.ts
// Manages the outbound WebSocket tunnel to the cloud relay.
// Creates virtual WsConnections in ws.service for relay-forwarded clients.
// Registers the query-engine protocol handler for q:* frames.
//
// Remote access belongs to the Deus account the desktop is signed in to. The
// tunnel opens with a Deus Cloud host ticket for this computer's machine in
// that account; the relay admits only the same account's devices and names
// each one's account, and a pairing made here is bound to it.

import { execSync } from "child_process";
import { hostname, userInfo, platform } from "os";
import { WebSocket } from "ws";
import { match } from "ts-pattern";
import { RELAY_PROTOCOL, type ServerFrame, type RelayFrame } from "@shared/types/relay";
import { getSetting } from "./settings.service";
import {
  validateDeviceToken,
  authorizePairing,
  createDeviceToken,
  updateLastSeen,
} from "./remote-auth.service";
import {
  currentAccountSession,
  forgetRemovedMachine,
  getMachineId,
  isMachineRemoved,
  MachineRemovedError,
  obtainHostTicket,
} from "./remote-machine.service";
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

/** What Settings shows: off, waiting for sign-in, dialing, serving viewers, or removed. */
export type RelayState = "off" | "signed_out" | "connecting" | "connected" | "removed";

// ---- Tunnel State ----

let tunnelWs: WebSocket | null = null;
/** The account the current tunnel serves; a different signed-in account replaces it. */
let hostAccount: string | null = null;
let machineId: string | null = null;
let dial: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stableTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let lastError: string | null = null;

// ---- Relay clients ----

const clientToConn = new Map<string, string>();

function unlinkClient(clientId: string): string | undefined {
  const connectionId = clientToConn.get(clientId);
  clientToConn.delete(clientId);
  return connectionId;
}

const MAX_RECONNECT_DELAY = 30_000;
const BASE_RECONNECT_DELAY = 1_000;
/** A tunnel must stay registered this long before backoff starts over. */
const STABLE_TUNNEL_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** The relay's close reason when another tunnel for this machine replaced ours. */
const DISPLACED = "New tunnel connection";

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

/**
 * Bring the tunnel in line with Settings and the desktop's account: open it
 * when remote access is on and an account is signed in, replace it when the
 * account changes, and close it otherwise. Idempotent; call it on any change.
 * `restart` is the user turning remote access on, which re-adds a computer the
 * account removed.
 */
export function reconcileRelay({ restart = false }: { restart?: boolean } = {}): void {
  const enabled = getSetting("remote_access_enabled") === true;
  const session = enabled ? currentAccountSession() : null;
  if (session && restart) forgetRemovedMachine(session.accountId);
  if (!session || isMachineRemoved(session.accountId)) {
    if (hostAccount !== null || tunnelWs || dial || reconnectTimer) disconnectFromRelay();
    return;
  }
  if (hostAccount === session.accountId && (tunnelWs || dial || reconnectTimer)) return;

  disconnectFromRelay();
  hostAccount = session.accountId;
  machineId = getMachineId(session.accountId);
  reconnectAttempt = 0;
  void openTunnel();
}

export function disconnectFromRelay(): void {
  hostAccount = null;
  machineId = null;
  lastError = null;
  dial?.abort();
  dial = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
  const socket = tunnelWs;
  tunnelWs = null;
  socket?.close(1000, "Disconnecting");
  dropClients();
}

export function getRelayStatus(): {
  state: RelayState;
  connected: boolean;
  clients: number;
  serverId: string | null;
  serverName: string;
  accountId: string | null;
  relayUrl: string;
  error: string | null;
  /** This computer's OS, for a viewer on another device ("Keep this Mac awake"). */
  platform: NodeJS.Platform;
} {
  const enabled = getSetting("remote_access_enabled") === true;
  const connected = tunnelWs?.readyState === WebSocket.OPEN;
  const session = enabled && !hostAccount ? currentAccountSession() : null;
  const removed = session !== null && isMachineRemoved(session.accountId);
  const state: RelayState = !enabled
    ? "off"
    : removed
      ? "removed"
      : !hostAccount
        ? "signed_out"
        : connected
          ? "connected"
          : "connecting";
  return {
    state,
    connected,
    clients: clientToConn.size,
    serverId: machineId,
    // Shown beside the pairing code so a code is typed into this computer only.
    serverName: getServerName(),
    accountId: hostAccount,
    relayUrl: DEFAULT_RELAY_URL,
    error:
      state === "connecting"
        ? lastError
        : state === "removed"
          ? new MachineRemovedError().message
          : null,
    platform: process.platform,
  };
}

// ---- Tunnel Lifecycle ----

async function openTunnel(): Promise<void> {
  const account = hostAccount;
  const session = currentAccountSession();
  if (!account || session?.accountId !== account) return;

  const controller = new AbortController();
  dial = controller;
  let hostTicket: { machineId: string; ticket: string };
  try {
    hostTicket = await obtainHostTicket(session, getServerName(), controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return;
    dial = null;
    if (err instanceof MachineRemovedError) {
      // Removing a computer is a decision, not an outage: stay off, don't re-register.
      console.log("[Relay] This computer was removed from the account; remote access is off");
      disconnectFromRelay();
      return;
    }
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[Relay] Could not obtain a host ticket: ${lastError}`);
    scheduleReconnect();
    return;
  }
  if (controller.signal.aborted || hostAccount !== account) return;
  dial = null;
  machineId = hostTicket.machineId;

  const url = `${DEFAULT_RELAY_URL}/api/servers/${machineId}/tunnel`;
  console.log(`[Relay] Connecting to ${url}...`);
  let socket: WebSocket;
  try {
    // Browsers can only send a credential as a subprotocol; the host does the same.
    socket = new WebSocket(url, [RELAY_PROTOCOL, hostTicket.ticket], {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
  } catch (err) {
    console.error("[Relay] Failed to create WebSocket:", err);
    scheduleReconnect();
    return;
  }
  tunnelWs = socket;
  // A replaced or abandoned socket's late events must not touch its successor.
  const current = () => tunnelWs === socket;

  socket.on("open", () => {
    if (!current()) return;
    console.log("[Relay] Tunnel connected, registering...");
    lastError = null;
    sendToRelay({ type: "register", serverName: getServerName() });
    // Start backoff over only once the tunnel has held: a tunnel that keeps
    // being replaced (two Deus apps hosting one machine) must not redial hot.
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = null;
      if (current()) reconnectAttempt = 0;
    }, STABLE_TUNNEL_MS);
  });

  socket.on("message", (raw: Buffer | string) => {
    if (!current()) return;
    try {
      const frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as RelayFrame;
      handleRelayFrame(frame);
    } catch {
      // Ignore malformed frames
    }
  });

  socket.on("unexpected-response", (_request, response) => {
    if (!current()) return;
    lastError = `The relay refused this computer (${response.statusCode})`;
    // With this listener ws leaves the handshake open; end it so `close` redials.
    response.resume();
    socket.terminate();
  });

  socket.on("close", (code, reason) => {
    if (!current()) return;
    console.log(`[Relay] Tunnel closed: ${code} ${reason}`);
    tunnelWs = null;
    dropClients();
    if (String(reason) === DISPLACED) {
      lastError = "Another Deus app on this computer is hosting remote access";
      reconnectAttempt = Math.max(reconnectAttempt, 5);
    }
    scheduleReconnect();
  });

  socket.on("error", (err) => {
    if (!current()) return;
    console.error("[Relay] Tunnel error:", err.message);
  });
}

function dropClients(): void {
  for (const [, connId] of clientToConn) {
    removeConnection(connId);
  }
  clientToConn.clear();
}

function handleRelayFrame(frame: RelayFrame): void {
  match(frame)
    .with({ type: "registered" }, () => {
      console.log("[Relay] Registered with relay successfully");
    })
    .with({ type: "client_connected" }, (f) => {
      const device = validateDeviceToken(f.deviceToken);
      // A pairing works only for the account and machine it was made for, on this
      // account's tunnel: removing the computer from the account retires its grants.
      if (
        device &&
        machineId &&
        device.account_id === f.accountId &&
        device.machine_id === machineId &&
        f.accountId === hostAccount
      ) {
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
      handlePairRequest(f.pairId, f.code, f.deviceName, f.accountId);
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

function handlePairRequest(
  pairId: string,
  code: string,
  deviceName: string,
  accountId: string
): void {
  if (accountId !== hostAccount || !machineId) {
    sendToRelay({
      type: "pair_response",
      pairId,
      success: false,
      reason: "This computer is signed in to another Deus account",
    });
    return;
  }
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

  const { token } = createDeviceToken(deviceName || "Web Portal", null, "relay-paired", {
    accountId,
    machineId,
  });
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
  if (reconnectTimer || !hostAccount) return;
  const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY);
  reconnectAttempt++;
  console.log(`[Relay] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openTunnel();
  }, delay);
}
