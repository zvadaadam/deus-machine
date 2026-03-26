// Cloudflare Durable Object for relay WebSocket multiplexing.
// One DO per Deus server. Holds the server tunnel + all client connections.
// Uses the WebSocket Hibernation API for efficient connection handling.
// All mutable state lives in ctx.storage to survive hibernation.
//
// Storage keys:
//   relayToken                   — server's relay token (set on first registration)
//   tunnelRegistered             — boolean, true after successful register handshake
//   serverDisconnectedAt         — timestamp when server disconnected (persists until reconnect)
//   serverName                   — server name for display to clients
//   pending:<clientId>           — auth deadline timestamp for pending clients
//   auth_token:<clientId>        — client's device token (stored for re-forwarding on reconnect)
//   pending:pair:<pairId>       — deadline timestamp for one-shot pairing requests

import { DurableObject } from "cloudflare:workers";
import type {
  PairerFrame,
  RelayClientFrame,
  RelayFrame,
  RelayPairerFrame,
  ServerFrame,
} from "../../../shared/types/relay";
import { clientAuthFrameSchema, pairerFrameSchema, serverFrameSchema } from "./schemas";

const AUTH_TIMEOUT_MS = 5_000;
const OFFLINE_WAIT_MS = 300_000; // 5 min — max time a client waits for server to reconnect
const HEARTBEAT_INTERVAL_MS = 30_000;
const PAIR_TIMEOUT_MS = 30_000;

export class RelayDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/tunnel") {
      return this.handleTunnel(request);
    }
    if (url.pathname === "/connect") {
      return this.handleClient(request);
    }
    if (url.pathname === "/pair") {
      return this.handlePairer(request);
    }
    if (url.pathname === "/status") {
      return this.handleStatus();
    }

    return new Response("Not found", { status: 404 });
  }

  // ---- Server Tunnel ----

  private async handleTunnel(request: Request): Promise<Response> {
    // Authenticate BEFORE closing existing tunnels to prevent unauthenticated
    // connections from disrupting a legitimate server's tunnel (DoS).
    const storedToken = await this.ctx.storage.get<string>("relayToken");
    if (storedToken) {
      const url = new URL(request.url);
      const token =
        request.headers.get("Authorization")?.replace("Bearer ", "") ||
        url.searchParams.get("token");
      if (token !== storedToken) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

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

    this.ctx.acceptWebSocket(server, ["tunnel"]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Client Connection ----

  private async handleClient(_request: Request): Promise<Response> {
    const tunnels = this.ctx.getWebSockets("tunnel");
    if (tunnels.length === 0) {
      // Accept connections if server was ever registered — it may come back.
      // Only reject for completely unknown servers (never registered).
      const hasEverRegistered = await this.ctx.storage.get<string>("relayToken");
      if (!hasEverRegistered) {
        return Response.json({ error: "server_not_found" }, { status: 503 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    const clientId = crypto.randomUUID();
    // Tags are immutable after acceptWebSocket — don't encode mutable state in them.
    // Auth state is tracked via storage keys instead.
    this.ctx.acceptWebSocket(server, ["client", clientId]);

    // Store auth deadline in durable storage (survives hibernation)
    await this.ctx.storage.put(`pending:${clientId}`, Date.now() + AUTH_TIMEOUT_MS);
    await this.scheduleNextAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Status ----

  private async handleStatus(): Promise<Response> {
    const tunnels = this.ctx.getWebSockets("tunnel");
    const allClients = this.ctx.getWebSockets("client");
    const pendingClientCount = (await this.getPendingClients()).size;
    const serverDisconnectedAt = await this.ctx.storage.get<number>("serverDisconnectedAt");
    const serverName = await this.ctx.storage.get<string>("serverName");

    return Response.json({
      online: tunnels.length > 0,
      clients: Math.max(0, allClients.length - pendingClientCount),
      reconnecting: serverDisconnectedAt !== undefined,
      serverDisconnectedAt: serverDisconnectedAt ?? null,
      serverName: serverName || null,
    });
  }

  // ---- Pairing (one-shot code exchange) ----

  private async handlePairer(_request: Request): Promise<Response> {
    // Pairing requires an active, registered server tunnel
    const tunnel = this.getTunnel();
    const isRegistered = await this.ctx.storage.get<boolean>("tunnelRegistered");
    if (!tunnel || !isRegistered) {
      return Response.json({ error: "server_offline" }, { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    const pairId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, ["pairer", pairId]);

    // Store deadline for cleanup via alarm
    await this.ctx.storage.put(`pending:pair:${pairId}`, Date.now() + PAIR_TIMEOUT_MS);
    await this.scheduleNextAlarm();

    return new Response(null, { status: 101, webSocket: client });
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
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    await this.handleWebSocketTermination(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.handleWebSocketTermination(ws);
  }

  private async handleWebSocketTermination(ws: WebSocket): Promise<void> {
    const tags = this.ctx.getTags(ws);

    if (tags.includes("tunnel")) {
      await this.handleServerDisconnect();
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
        this.rejectClient(clientId, "Authentication timeout");
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

    // 2. Send heartbeat ping to server
    const tunnel = this.getTunnel();
    if (tunnel) {
      this.safeSend(tunnel, { type: "ping" });
    }

    // 3. Reschedule for next event
    await this.scheduleNextAlarm();
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
    const storedToken = await this.ctx.storage.get<string>("relayToken");
    if (storedToken && storedToken !== frame.relayToken) {
      this.safeSend(ws, { type: "error", message: "Invalid relay token" });
      try {
        ws.close(4003, "Invalid relay token");
      } catch (err) {
        console.error("relay: failed to close tunnel with bad token", err);
      }
      return;
    }

    if (!storedToken) {
      await this.ctx.storage.put("relayToken", frame.relayToken);
    }

    // Always update server name (user might have changed it)
    if (frame.serverName) {
      await this.ctx.storage.put("serverName", frame.serverName);
    }

    // Mark tunnel as registered — gates auth_response/data processing
    await this.ctx.storage.put("tunnelRegistered", true);

    // Clear reconnection state and notify clients server is back
    const wasReconnecting = await this.ctx.storage.get<number>("serverDisconnectedAt");
    await this.ctx.storage.delete("serverDisconnectedAt");

    // Confirm registration to the WebSocket that sent it
    this.safeSend(ws, { type: "registered" });

    // Notify already-authenticated clients that the server is back.
    // Pending clients are notified via the normal auth flow (they'll get "authenticated").
    if (wasReconnecting !== undefined) {
      const clients = this.ctx.getWebSockets("client");
      for (const clientWs of clients) {
        const clientId = this.ctx.getTags(clientWs).find((t) => t !== "client");
        if (!clientId) continue;
        const isPending = await this.ctx.storage.get<number>(`pending:${clientId}`);
        if (isPending !== undefined) continue;
        this.safeSend(clientWs, { type: "server_connected" });
      }
    }

    // Always re-forward pending clients' stored auth tokens to the new tunnel.
    // This handles both reconnection (wasReconnecting) and tunnel replacement
    // (where serverDisconnectedAt was never set because the old tunnel's close
    // handler saw the new tunnel already existed).
    const pendingClients = await this.getPendingClients();
    for (const [pendingClientId] of pendingClients) {
      const storedAuthToken = await this.ctx.storage.get<string>(`auth_token:${pendingClientId}`);
      if (storedAuthToken) {
        this.safeSend(ws, {
          type: "client_connected",
          clientId: pendingClientId,
          deviceToken: storedAuthToken,
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

    if (isPending !== undefined) {
      // Client is still pending — only accept authenticate messages
      const authResult = clientAuthFrameSchema.safeParse(json);
      if (!authResult.success) return;

      const { token } = authResult.data;
      // Store the token so we can re-forward it if the server reconnects
      await this.ctx.storage.put(`auth_token:${clientId}`, token);

      const tunnel = this.getTunnel();
      const isRegistered = await this.ctx.storage.get<boolean>("tunnelRegistered");
      if (tunnel && isRegistered) {
        this.safeSend(tunnel, {
          type: "client_connected",
          clientId,
          deviceToken: token,
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
    if (tunnel && isRegistered) {
      this.safeSend(tunnel, {
        type: "pair_request",
        pairId,
        code: frame.code,
        deviceName: frame.deviceName,
      });
    } else {
      const pairerWs = this.findPairerWs(pairId);
      if (pairerWs) {
        this.safeSend(pairerWs, { type: "pair_failed", message: "Server is offline" });
        try {
          pairerWs.close(1000, "Server offline");
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

  private async handleServerDisconnect(): Promise<void> {
    // If another tunnel is already active (e.g. old tunnel's close callback firing
    // after handleTunnel replaced it), skip the disconnect flow.
    const tunnels = this.ctx.getWebSockets("tunnel");
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
    return tunnels[0] ?? null;
  }

  private safeSend(ws: WebSocket, data: RelayFrame | RelayClientFrame | RelayPairerFrame): void {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error("relay: safeSend failed", err);
    }
  }
}
