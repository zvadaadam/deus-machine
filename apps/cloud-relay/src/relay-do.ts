// Cloudflare Durable Object for relay WebSocket multiplexing.
// One DO per registered computer. Holds its tunnel + all client connections.
// Uses the WebSocket Hibernation API for efficient connection handling.
// All mutable state lives in ctx.storage to survive hibernation.
//
// The Worker (index.ts) verifies each socket's Deus Cloud ticket and passes
// its claims in ADMISSION_HEADER. This object pins the machine to the account
// of the first host ticket, admits only that account's clients, consumes each
// ticket once, and tells the host which account every client belongs to.
//
// Storage keys:
//   owner                        — account the machine belongs to (pinned by its first host)
//   ticket:<jti>                 — when to forget a consumed ticket (replay protection)
//   tunnelRegistered             — boolean, true after successful register handshake
//   serverDisconnectedAt         — timestamp when server disconnected (persists until reconnect)
//   serverName                   — server name for display to clients
//   pending:<clientId>           — auth deadline timestamp for pending clients
//   auth_token:<clientId>        — client's device token (stored for re-forwarding on reconnect)
//   pending:pair:<pairId>       — deadline timestamp for one-shot pairing requests

import { DurableObject } from "cloudflare:workers";
import {
  RELAY_PROTOCOL,
  type PairerFrame,
  type RelayClientFrame,
  type RelayFrame,
  type RelayPairerFrame,
  type ServerFrame,
} from "../../../shared/types/relay";
import { clientAuthFrameSchema, pairerFrameSchema, serverFrameSchema } from "./schemas";
import { admissionSchema, type Admission, type RelayRole } from "./tickets";

/** Set by the Worker after ticket verification; never trusted from a peer. */
export const ADMISSION_HEADER = "x-deus-relay-admission";
const RELAY_PROTOCOL_RESPONSE = { "Sec-WebSocket-Protocol": RELAY_PROTOCOL };

/** Survives hibernation with the socket: whose account and role it was admitted for. */
interface SocketIdentity {
  accountId: string;
  role: RelayRole;
}

const AUTH_TIMEOUT_MS = 5_000;
/** A consumed ticket is remembered past its expiry, so clock skew cannot reopen it. */
const TICKET_RETENTION_MS = 60_000;
const OFFLINE_WAIT_MS = 300_000; // 5 min — max time a client waits for server to reconnect
const HEARTBEAT_INTERVAL_MS = 30_000;
const PAIR_TIMEOUT_MS = 30_000;
/** Shown by the pairing page: only the computer itself can approve a device. */
const COMPUTER_OFFLINE = "This computer is offline. Open Deus on it, then try again.";

export class RelayDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const handler = (
      {
        "/tunnel": this.handleTunnel,
        "/connect": this.handleClient,
        "/pair": this.handlePairer,
      } as const
    )[url.pathname as "/tunnel"];
    if (!handler) return new Response("Not found", { status: 404 });

    const admission = this.readAdmission(request);
    const expectedRole: RelayRole = url.pathname === "/tunnel" ? "host" : "client";
    if (!admission || admission.role !== expectedRole) {
      return Response.json({ error: "Account ticket required" }, { status: 401 });
    }
    const rejected = await this.admit(admission);
    if (rejected) return rejected;
    return handler.call(this, admission);
  }

  // ---- Admission ----

  private readAdmission(request: Request): Admission | null {
    try {
      const parsed = admissionSchema.safeParse(JSON.parse(request.headers.get(ADMISSION_HEADER)!));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Pins the owner on the first host and consumes the ticket. Storage-only: no other I/O interleaves. */
  private async admit(admission: Admission): Promise<Response | null> {
    const owner = await this.ctx.storage.get<string>("owner");
    if (!owner && admission.role === "client") {
      return Response.json({ error: "server_not_found" }, { status: 503 });
    }
    if (owner && owner !== admission.accountId) {
      return Response.json({ error: "This computer belongs to another account" }, { status: 403 });
    }
    const ticketKey = `ticket:${admission.ticketId}`;
    if ((await this.ctx.storage.get<number>(ticketKey)) !== undefined) {
      return Response.json({ error: "Ticket already used" }, { status: 401 });
    }
    const forgetAt = admission.expiresAt + TICKET_RETENTION_MS;
    await this.ctx.storage.put({
      [ticketKey]: forgetAt,
      ...(owner ? {} : { owner: admission.accountId }),
    });
    // The alarm chain sweeps consumed tickets; start one if nothing else will.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(forgetAt);
    return null;
  }

  // ---- Server Tunnel ----

  private async handleTunnel(admission: Admission): Promise<Response> {
    // Close any existing tunnel before accepting a new one to prevent
    // stale connections from receiving messages meant for the new tunnel.
    const existingTunnels = this.ctx.getWebSockets("tunnel");
    for (const tunnel of existingTunnels) {
      try {
        tunnel.close(1000, "New tunnel connection");
      } catch (err) {
        console.error("relay: failed to close existing tunnel", err);
      }
    }

    // New tunnel is not yet registered — must complete register handshake first
    await this.ctx.storage.put("tunnelRegistered", false);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.acceptSocket(server, ["tunnel"], admission);

    return this.upgraded(client);
  }

  // ---- Client Connection ----

  private async handleClient(admission: Admission): Promise<Response> {
    // An owned machine accepts viewers while its host is away: it may come back.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    const clientId = crypto.randomUUID();
    // Tags are immutable after acceptWebSocket — don't encode mutable state in them.
    // Auth state is tracked via storage keys instead.
    this.acceptSocket(server, ["client", clientId], admission);

    // Store auth deadline in durable storage (survives hibernation)
    await this.ctx.storage.put(`pending:${clientId}`, Date.now() + AUTH_TIMEOUT_MS);
    await this.scheduleNextAlarm();

    return this.upgraded(client);
  }

  // ---- Pairing (one-shot code exchange) ----

  private async handlePairer(admission: Admission): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Pairing requires an active, registered server tunnel. A browser cannot
    // read a refused upgrade's status, so the refusal is said on the socket.
    const tunnel = this.getTunnel();
    const isRegistered = await this.ctx.storage.get<boolean>("tunnelRegistered");
    if (!tunnel || !isRegistered) {
      server.accept();
      this.safeSend(server, { type: "pair_failed", message: COMPUTER_OFFLINE });
      server.close(1000, "Computer offline");
      return this.upgraded(client);
    }

    const pairId = crypto.randomUUID();
    this.acceptSocket(server, ["pairer", pairId], admission);

    // Store deadline for cleanup via alarm
    await this.ctx.storage.put(`pending:pair:${pairId}`, Date.now() + PAIR_TIMEOUT_MS);
    await this.scheduleNextAlarm();

    return this.upgraded(client);
  }

  /** A browser fails the handshake unless the offered subprotocol is echoed back. */
  private upgraded(client: WebSocket): Response {
    return new Response(null, { status: 101, webSocket: client, headers: RELAY_PROTOCOL_RESPONSE });
  }

  // ---- WebSocket Handlers (Hibernation API) ----

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.error("relay: failed to parse WebSocket message as JSON");
      return;
    }

    if (tags.includes("tunnel")) {
      if (!this.ctx.getWebSockets("tunnel").includes(ws)) return;
      const result = serverFrameSchema.safeParse(json);
      if (!result.success) {
        console.error("relay: invalid server frame", result.error.issues);
        return;
      }
      // Cast is safe — Zod validated the shape, but its inferred type for pair_response
      // uses `success: boolean` while our ServerFrame uses discriminated `true | false`.
      await this.handleServerMessage(ws, result.data as ServerFrame);
    } else if (tags.includes("pairer")) {
      const pairId = tags.find((t) => t !== "pairer");
      if (!pairId) return;
      const result = pairerFrameSchema.safeParse(json);
      if (!result.success) {
        console.error("relay: invalid pairer frame", result.error.issues);
        return;
      }
      await this.handlePairerMessage(pairId, result.data);
    } else if (tags.includes("client")) {
      const clientId = tags.find((t) => t !== "client");
      if (!clientId) return;
      await this.handleClientMessage(clientId, json);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // Our 2025 compatibility date requires a reciprocal Close frame. Otherwise
    // a CLOSING socket can remain in getWebSockets() after its peer has gone.
    // https://developers.cloudflare.com/durable-objects/api/base/#websocketclose
    try {
      ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    } catch {
      // The transport may already have failed; still remove its logical state.
    }
    await this.handleWebSocketTermination(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.handleWebSocketTermination(ws);
  }

  private async handleWebSocketTermination(ws: WebSocket): Promise<void> {
    const tags = this.ctx.getTags(ws);

    if (tags.includes("tunnel")) {
      await this.handleServerDisconnect(ws);
    } else if (tags.includes("pairer")) {
      const pairId = tags.find((t) => t !== "pairer");
      if (pairId) {
        await this.ctx.storage.delete(`pending:pair:${pairId}`);
      }
    } else if (tags.includes("client")) {
      const clientId = tags.find((t) => t !== "client");
      if (clientId) {
        await this.handleClientDisconnect(clientId);
      }
    }
  }

  // ---- Alarm (auth timeout + heartbeat) ----

  async alarm(): Promise<void> {
    const now = Date.now();

    // 1. Reject clients whose auth deadline has expired
    const pendingClients = await this.getPendingClients();
    const expiredClientIds: string[] = [];
    for (const [clientId, deadline] of pendingClients) {
      if (now >= deadline) {
        expiredClientIds.push(clientId);
      }
    }
    if (expiredClientIds.length > 0) {
      const keysToDelete = expiredClientIds.flatMap((id) => [`pending:${id}`, `auth_token:${id}`]);
      await this.ctx.storage.delete(keysToDelete);
      for (const clientId of expiredClientIds) {
        // A slow handshake says nothing about credential validity. Retry the
        // connection without sending auth_failed (which removes the pairing).
        const clientWs = this.findClientWs(clientId);
        if (clientWs) {
          this.safeSend(clientWs, { type: "error", message: "Authentication timeout" });
          try {
            clientWs.close(1013, "Authentication timeout");
          } catch {
            // Already closed; pending state was removed above.
          }
        }
      }
    }

    // 1b. Reject pairers whose deadline has expired
    const pendingPairs = await this.ctx.storage.list<number>({ prefix: "pending:pair:" });
    for (const [key, deadline] of pendingPairs) {
      if (now >= deadline) {
        const pairId = key.slice("pending:pair:".length);
        const pairerWs = this.findPairerWs(pairId);
        if (pairerWs) {
          this.safeSend(pairerWs, { type: "pair_failed", message: "Pairing timed out" });
          try {
            pairerWs.close(1000, "Pairing timed out");
          } catch (err) {
            console.error("relay: failed to close expired pairer", err);
          }
        }
        await this.ctx.storage.delete(key);
      }
    }

    // 1c. Forget consumed tickets once they could no longer be presented
    const consumed = await this.ctx.storage.list<number>({ prefix: "ticket:" });
    const expiredTickets = [...consumed].filter(([, expiry]) => expiry <= now).map(([key]) => key);
    for (let i = 0; i < expiredTickets.length; i += 128) {
      await this.ctx.storage.delete(expiredTickets.slice(i, i + 128));
    }
    const remaining = [...consumed.values()].filter((expiry) => expiry > now);

    // 2. Send heartbeat ping to server
    const tunnel = this.getTunnel();
    if (tunnel) {
      this.safeSend(tunnel, { type: "ping" });
    }

    // 3. Reschedule for next event, including the sweep of tickets still remembered
    await this.scheduleNextAlarm();
    if (remaining.length > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Math.min(...remaining));
    }
  }

  // ---- Server Message Handling ----

  private async handleServerMessage(ws: WebSocket, frame: ServerFrame): Promise<void> {
    const isRegistered = await this.ctx.storage.get<boolean>("tunnelRegistered");

    switch (frame.type) {
      case "register": {
        await this.handleRegister(ws, frame);
        break;
      }
      case "auth_response": {
        // Only registered tunnels may send auth_response
        if (!isRegistered) break;
        await this.handleAuthResponse(frame.clientId, frame.allowed, frame.reason);
        break;
      }
      case "pair_response": {
        if (!isRegistered) break;
        await this.ctx.storage.delete(`pending:pair:${frame.pairId}`);
        const pairerWs = this.findPairerWs(frame.pairId);
        if (!pairerWs) break;
        if (frame.success) {
          this.safeSend(pairerWs, { type: "pair_success", token: frame.deviceToken });
        } else {
          this.safeSend(pairerWs, { type: "pair_failed", message: frame.reason });
        }
        // Close the one-shot pairer WS — buffered messages are sent before the close frame
        try {
          pairerWs.close(1000, "Pairing complete");
        } catch (err) {
          console.error("relay: failed to close pairer after response", err);
        }
        break;
      }
      case "data": {
        // Only registered tunnels may send data
        if (!isRegistered) break;
        await this.forwardToClient(frame.clientId, frame.payload);
        break;
      }
      case "pong": {
        break;
      }
    }
  }

  private async handleRegister(
    ws: WebSocket,
    frame: Extract<ServerFrame, { type: "register" }>
  ): Promise<void> {
    // The tunnel's ticket already proved the host; registering only names it.
    // Always update server name (user might have changed it)
    if (frame.serverName) {
      await this.ctx.storage.put("serverName", frame.serverName);
    }

    // Mark tunnel as registered — gates auth_response/data processing
    await this.ctx.storage.put("tunnelRegistered", true);

    // Clear the previous outage before admitting viewers on this host.
    await this.ctx.storage.delete("serverDisconnectedAt");

    // Confirm registration to the WebSocket that sent it
    this.safeSend(ws, { type: "registered" });

    // A replacement host has no virtual connection for an already-authorized
    // viewer. Its token was deliberately discarded after the original auth.
    // Redial and reauthorize instead of claiming the host is ready prematurely.
    // This also handles a hot replacement without a preceding disconnect event.
    for (const clientWs of this.ctx.getWebSockets("client")) {
      const clientId = this.ctx.getTags(clientWs).find((tag) => tag !== "client");
      if (!clientId || (await this.ctx.storage.get<number>(`pending:${clientId}`)) !== undefined)
        continue;
      // Block data immediately, before the socket's close callback arrives.
      await this.ctx.storage.put(`pending:${clientId}`, Date.now() + AUTH_TIMEOUT_MS);
      try {
        clientWs.close(1012, "Host reconnected; authenticate again");
      } catch (error) {
        console.error("relay: failed to close client for reauthorization", error);
      }
    }

    // Always re-forward pending clients' stored auth tokens to the new tunnel.
    // This handles both reconnection and tunnel replacement
    // (where serverDisconnectedAt was never set because the old tunnel's close
    // handler saw the new tunnel already existed).
    const pendingClients = await this.getPendingClients();
    for (const [pendingClientId] of pendingClients) {
      const storedAuthToken = await this.ctx.storage.get<string>(`auth_token:${pendingClientId}`);
      const accountId = this.accountOf(this.findClientWs(pendingClientId));
      if (storedAuthToken && accountId) {
        this.safeSend(ws, {
          type: "client_connected",
          clientId: pendingClientId,
          deviceToken: storedAuthToken,
          accountId,
        });
      }
    }

    // Start heartbeat
    await this.scheduleNextAlarm();
  }

  // ---- Auth Delegation ----

  private async handleAuthResponse(
    clientId: string,
    allowed: boolean,
    reason?: string
  ): Promise<void> {
    await this.ctx.storage.delete(`pending:${clientId}`);
    await this.ctx.storage.delete(`auth_token:${clientId}`);

    if (allowed) {
      this.activateClient(clientId);
    } else {
      this.rejectClient(clientId, reason || "Authentication denied");
    }
  }

  private activateClient(clientId: string): void {
    const ws = this.findClientWs(clientId);
    if (ws) {
      this.safeSend(ws, { type: "authenticated" });
    }
  }

  private rejectClient(clientId: string, message: string): void {
    const ws = this.findClientWs(clientId);
    if (ws) {
      this.safeSend(ws, { type: "auth_failed", message });
      try {
        ws.close(4003, message);
      } catch (err) {
        console.error(`relay: failed to close rejected client ${clientId}`, err);
      }
    }
  }

  // ---- Client Message Handling ----

  private async handleClientMessage(clientId: string, json: unknown): Promise<void> {
    const isPending = await this.ctx.storage.get<number>(`pending:${clientId}`);

    // An offline host cannot answer the end-to-end probe. Keep the waiting
    // client's relay connection alive without authenticating it or forwarding
    // application data. Once authorized, probes travel all the way to the host.
    if (
      typeof json === "object" &&
      json !== null &&
      "type" in json &&
      json.type === "ping" &&
      "id" in json &&
      typeof json.id === "string"
    ) {
      if (
        isPending !== undefined ||
        !this.getTunnel() ||
        !(await this.ctx.storage.get<boolean>("tunnelRegistered"))
      ) {
        const clientWs = this.findClientWs(clientId);
        if (clientWs) this.safeSend(clientWs, { type: "pong", id: json.id });
        return;
      }
    }

    if (isPending !== undefined) {
      // Client is still pending — only accept authenticate messages
      const authResult = clientAuthFrameSchema.safeParse(json);
      if (!authResult.success) return;

      const { token } = authResult.data;
      // Store the token so we can re-forward it if the server reconnects
      await this.ctx.storage.put(`auth_token:${clientId}`, token);

      const tunnel = this.getTunnel();
      const isRegistered = await this.ctx.storage.get<boolean>("tunnelRegistered");
      const accountId = this.accountOf(this.findClientWs(clientId));
      if (tunnel && isRegistered && accountId) {
        this.safeSend(tunnel, {
          type: "client_connected",
          clientId,
          deviceToken: token,
          accountId,
        });
      } else if (tunnel) {
        // Tunnel exists but not yet registered — replacement in progress.
        // Leave client pending; handleRegister will re-forward the stored
        // auth token once the new tunnel completes registration.
        // The auth timeout alarm will reject naturally if registration never comes.
      } else {
        // Server tunnel is down — keep client waiting for server to return.
        // Suspend the short auth deadline; handleRegister will re-forward the
        // stored auth token when the server reconnects.
        const serverDisconnectedAt = await this.ctx.storage.get<number>("serverDisconnectedAt");
        await this.ctx.storage.put(`pending:${clientId}`, Date.now() + OFFLINE_WAIT_MS);
        const clientWs = this.findClientWs(clientId);
        if (clientWs) {
          const serverName = await this.ctx.storage.get<string>("serverName");
          this.safeSend(clientWs, {
            type: "server_reconnecting",
            serverDisconnectedAt: serverDisconnectedAt ?? Date.now(),
            serverName: serverName || null,
          });
        }
      }
      return;
    }

    // Authenticated client — forward data to server
    const tunnel = this.getTunnel();
    if (tunnel) {
      this.safeSend(tunnel, {
        type: "data",
        clientId,
        payload: JSON.stringify(json),
      });
    }
  }

  // ---- Pairer Message Handling ----

  private async handlePairerMessage(pairId: string, frame: PairerFrame): Promise<void> {
    const isPending = await this.ctx.storage.get<number>(`pending:pair:${pairId}`);
    if (isPending === undefined) return;

    const tunnel = this.getTunnel();
    const isRegistered = await this.ctx.storage.get<boolean>("tunnelRegistered");
    const accountId = this.accountOf(this.findPairerWs(pairId));
    if (tunnel && isRegistered && accountId) {
      this.safeSend(tunnel, {
        type: "pair_request",
        pairId,
        code: frame.code,
        deviceName: frame.deviceName,
        accountId,
      });
    } else {
      const pairerWs = this.findPairerWs(pairId);
      if (pairerWs) {
        this.safeSend(pairerWs, { type: "pair_failed", message: COMPUTER_OFFLINE });
        try {
          pairerWs.close(1000, "Computer offline");
        } catch (err) {
          console.error("relay: failed to close pairer (server offline)", err);
        }
      }
      await this.ctx.storage.delete(`pending:pair:${pairId}`);
    }
  }

  // ---- Client/Server Lifecycle ----

  private async handleClientDisconnect(clientId: string): Promise<void> {
    await this.ctx.storage.delete(`pending:${clientId}`);
    await this.ctx.storage.delete(`auth_token:${clientId}`);

    const tunnel = this.getTunnel();
    if (tunnel) {
      this.safeSend(tunnel, {
        type: "client_disconnected",
        clientId,
      });
    }
  }

  private async handleServerDisconnect(terminated: WebSocket): Promise<void> {
    // If another tunnel is already active (e.g. old tunnel's close callback firing
    // after handleTunnel replaced it), skip the disconnect flow.
    const tunnels = this.ctx
      .getWebSockets("tunnel")
      .filter((socket) => socket !== terminated && socket.readyState === 1);
    if (tunnels.length > 0) return;

    const existing = await this.ctx.storage.get<number>("serverDisconnectedAt");
    if (existing !== undefined) return; // Already handling disconnect

    await this.ctx.storage.put("tunnelRegistered", false);
    const disconnectedAt = Date.now();
    await this.ctx.storage.put("serverDisconnectedAt", disconnectedAt);

    const serverName = await this.ctx.storage.get<string>("serverName");
    const clients = this.ctx.getWebSockets("client");
    for (const clientWs of clients) {
      this.safeSend(clientWs, {
        type: "server_reconnecting",
        serverDisconnectedAt: disconnectedAt,
        serverName: serverName || null,
      });
    }

    await this.scheduleNextAlarm();
  }

  // ---- Data Forwarding ----

  private async forwardToClient(clientId: string, payload: string): Promise<void> {
    const isPending = await this.ctx.storage.get<number>(`pending:${clientId}`);
    if (isPending !== undefined) {
      return;
    }

    const ws = this.findClientWs(clientId);
    if (ws) {
      try {
        ws.send(payload);
      } catch (err) {
        console.error(`relay: failed to forward data to client ${clientId}`, err);
      }
    }
  }

  // ---- Alarm Scheduling ----

  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const candidates: number[] = [];

    // All pending deadlines (clients + pairs share the "pending:" prefix)
    const allPending = await this.ctx.storage.list<number>({ prefix: "pending:" });
    for (const [, deadline] of allPending) {
      candidates.push(deadline);
    }

    // Heartbeat interval (only if server is connected)
    if (this.ctx.getWebSockets("tunnel").length > 0) {
      candidates.push(now + HEARTBEAT_INTERVAL_MS);
    }

    if (candidates.length > 0) {
      const nextAlarm = Math.min(...candidates);
      await this.ctx.storage.setAlarm(Math.max(nextAlarm, now + 100));
    }
  }

  // ---- Helpers ----

  /** Get pending client auth entries, filtering out pair entries that share the prefix. */
  private async getPendingClients(): Promise<Map<string, number>> {
    const entries = await this.ctx.storage.list<number>({ prefix: "pending:" });
    const result = new Map<string, number>();
    for (const [key, deadline] of entries) {
      if (key.startsWith("pending:pair:")) continue;
      result.set(key.slice("pending:".length), deadline);
    }
    return result;
  }

  private findWs(group: string, id: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(group)) {
      if (this.ctx.getTags(ws).includes(id)) return ws;
    }
    return null;
  }

  private findClientWs(clientId: string): WebSocket | null {
    return this.findWs("client", clientId);
  }

  private findPairerWs(pairId: string): WebSocket | null {
    return this.findWs("pairer", pairId);
  }

  private getTunnel(): WebSocket | null {
    const tunnels = this.ctx.getWebSockets("tunnel");
    return tunnels.find((socket) => socket.readyState === 1) ?? null;
  }

  private acceptSocket(ws: WebSocket, tags: string[], admission: Admission): void {
    this.ctx.acceptWebSocket(ws, tags);
    ws.serializeAttachment({
      accountId: admission.accountId,
      role: admission.role,
    } satisfies SocketIdentity);
  }

  private accountOf(ws: WebSocket | null): string | null {
    const identity = ws?.deserializeAttachment() as SocketIdentity | null | undefined;
    return identity?.accountId ?? null;
  }

  private safeSend(ws: WebSocket, data: RelayFrame | RelayClientFrame | RelayPairerFrame): void {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error("relay: safeSend failed", err);
    }
  }
}
