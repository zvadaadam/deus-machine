// backend/src/services/relay.service.ts
// Manages the outbound WebSocket tunnel to the cloud relay.
// Creates virtual WsConnections in ws.service for relay-forwarded clients.
// Registers the query-engine protocol handler for q:* frames.
//
// Remote access belongs to the Deus account the desktop is signed in to. The
// tunnel opens with a Deus Cloud host ticket for this computer's machine in
// that account; the relay admits only the same account's devices and names
// each one's account, and a pairing made here is bound to it.
//
// A hosted assistant arrives the same way, as a relay client, but with the
// account's access token instead of a device grant. This computer verifies
// the token itself (services/assistants); the relay and Deus Cloud only carry it.

import { WebSocket } from "ws";
import { match } from "ts-pattern";
import type { RelayState, RelayStatus } from "@shared/types/devices";
import { RELAY_PROTOCOL, type ServerFrame, type RelayFrame } from "@shared/types/relay";
import { getSetting } from "./settings.service";
import { getServerName } from "./server-name";
import {
  validateDeviceToken,
  authorizePairing,
  createDeviceToken,
  updateLastSeen,
} from "./remote-auth.service";
import { admitAssistant } from "./assistants";
import { SIGN_IN_UNCHECKED } from "./assistants/sentences";
import { assistantAddress, AssistantRefusedError, isAssistantToken } from "./assistants/token";
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
  FrameTooLarge,
  removeConnection,
  getConnection,
  setProtocolHandlers,
  handleProtocolMessage,
  type AssistantAdmission,
  type WsSendable,
} from "./ws.service";
import { handleFrame as handleQueryFrame, removeSubs as removeQuerySubs } from "./query-engine";

// ---- Tunnel State ----

let tunnelWs: WebSocket | null = null;
let registeredTunnel: WebSocket | null = null;
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
/** Relay clients whose assistant sign-in is being checked (the latest check each); gone once they disconnect. */
const admitting = new Map<string, symbol>();

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

/** This computer's address for assistants: it reaches the computer only through the tunnel it hosts. */
function assistantUrlOf(enabled: boolean): string | null {
  const session = enabled && hostAccount && machineId ? currentAccountSession() : null;
  return session?.accountId === hostAccount && machineId
    ? assistantAddress(session.cloudUrl, machineId)
    : null;
}

/** What Settings shows about the tunnel (`relayStatus`, and `GET /api/relay/status`). */
export function getRelayStatus(): RelayStatus {
  const enabled = getSetting("remote_access_enabled") === true;
  const connected = tunnelWs?.readyState === WebSocket.OPEN && tunnelWs === registeredTunnel;
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
    // For a viewer on another device ("Keep this Mac awake").
    platform: process.platform,
    assistantUrl: assistantUrlOf(enabled),
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
  admitting.clear();
}

/** Admit a relay client: a virtual connection whose data goes back through the tunnel. */
function attachClient(
  clientId: string,
  deviceId: string | null,
  admission: AssistantAdmission | null = null
): void {
  // Clean up existing connection (idempotent on tunnel reconnect)
  const existingConnId = clientToConn.get(clientId);
  if (existingConnId) {
    removeConnection(existingConnId);
  }

  // Virtual WsSendable routes data back through the relay tunnel
  const virtualWs: WsSendable = {
    send(data: string | ArrayBuffer) {
      const payload =
        typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
      sendToRelay({ type: "data", clientId, payload });
    },
    close(_code, reason) {
      unlinkClient(clientId);
      sendToRelay({ type: "auth_response", clientId, allowed: false, reason });
    },
  };
  clientToConn.set(clientId, addConnection(virtualWs, deviceId, true, admission));
  sendToRelay({ type: "auth_response", clientId, allowed: true });
}

/**
 * A relay client that offered an access token: an assistant. Verified here,
 * asynchronously; the tunnel, its account or the client may change meanwhile,
 * and then nothing is admitted.
 */
async function admitAssistantClient(
  f: Extract<RelayFrame, { type: "client_connected" }>
): Promise<void> {
  const refuse = (reason: string) =>
    sendToRelay({ type: "auth_response", clientId: f.clientId, allowed: false, reason });
  const socket = tunnelWs;
  const account = hostAccount;
  const machine = machineId;
  const session = currentAccountSession();
  if (
    !socket ||
    !account ||
    !machine ||
    f.accountId !== account ||
    session?.accountId !== account
  ) {
    refuse("This computer is signed in to another Deus account");
    return;
  }
  const check = Symbol(f.clientId);
  admitting.set(f.clientId, check);
  const current = () => admitting.get(f.clientId) === check && tunnelWs === socket;
  try {
    const admission = await admitAssistant(f.deviceToken, {
      accountId: account,
      machineId: machine,
      cloudUrl: session.cloudUrl,
    });
    if (!current() || hostAccount !== account) return;
    attachClient(f.clientId, null, admission);
    const { assistant } = admission;
    console.log(
      `[Relay] Client ${f.clientId} admitted as assistant ${assistant.clientId} (${assistant.access})`
    );
  } catch (error) {
    if (!current()) return;
    if (!(error instanceof AssistantRefusedError)) {
      console.error("[Relay] Assistant admission failed:", error);
    }
    refuse(error instanceof AssistantRefusedError ? error.message : SIGN_IN_UNCHECKED);
    console.log(`[Relay] Client ${f.clientId} assistant sign-in refused`);
  } finally {
    if (admitting.get(f.clientId) === check) admitting.delete(f.clientId);
  }
}

function handleRelayFrame(frame: RelayFrame): void {
  match(frame)
    .with({ type: "registered" }, () => {
      registeredTunnel = tunnelWs;
      console.log("[Relay] Registered with relay successfully");
    })
    .with({ type: "client_connected" }, (f) => {
      if (isAssistantToken(f.deviceToken)) {
        void admitAssistantClient(f);
        return;
      }
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
        attachClient(f.clientId, device.id);
        updateLastSeen(device.token_hash);
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
      admitting.delete(f.clientId);
      const connId = unlinkClient(f.clientId);
      if (connId) {
        removeConnection(connId);
        console.log(`[Relay] Client ${f.clientId} disconnected`);
      }
    })
    .with({ type: "data" }, (f) => {
      const connId = clientToConn.get(f.clientId);
      if (!connId) return;
      // Forgotten for going silent (ws.service): its probes go unanswered
      // until it reconnects.
      if (!getConnection(connId)) {
        clientToConn.delete(f.clientId);
        return;
      }

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

// https://developers.cloudflare.com/durable-objects/platform/limits/ — the Mac-to-relay
// envelope limit is 33,554,432 bytes in our measurements. Leave 4 KiB of headroom.
const MAX_RELAY_FRAME_BYTES = 32 * 1024 * 1024 - 4096;

function sendToRelay(frame: ServerFrame): void {
  if (tunnelWs?.readyState !== WebSocket.OPEN) return;
  const encoded = Buffer.from(JSON.stringify(frame));
  if (encoded.length > MAX_RELAY_FRAME_BYTES) {
    console.warn(`[Relay] Dropped ${frame.type} (${encoded.length} bytes)`);
    if (frame.type === "data") throw new FrameTooLarge(encoded.length);
    return;
  }
  try {
    tunnelWs.send(encoded, { binary: false });
  } catch {
    // Will be handled by close/error handlers
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
