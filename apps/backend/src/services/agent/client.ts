// backend/src/services/agent/client.ts
// The backend's link to the agent-server process, on the standard
// @zvada/agent-server wire: AgentServerClient (typed quick-ack turns,
// per-session seq dedupe, gap healing via events/replay, reconnect) over a
// WebSocket transport, with the deus/* side channel multiplexed on the same
// pipe (tool round-trips, AAP MCP hot-swap, provider auth, titles — see
// shared/agent-side-channel.ts).

import { WebSocket } from "ws";
import { AgentServerClient } from "@zvada/agent-server/client";
import type {
  InitializeResult,
  TurnCancelResult,
  TurnStartParams,
  WireEventEnvelope,
} from "@zvada/agent-server/protocol";
import {
  SIDE_CHANNEL,
  SideChannelEndpoint,
  claimSideChannel,
  wsLineTransport,
  type LineTransport,
  type SideChannelTitle,
} from "@shared/agent-side-channel";
import { AgentHarnessSchema, type AgentHarness } from "@shared/enums";
import type { AgentInfo } from "@shared/agent-info";

// ============================================================================
// Types
// ============================================================================

export interface AgentLinkOptions {
  /** ws://127.0.0.1:{port} — the agent-server URL. */
  url: string;
  /** Every sequenced lifecycle envelope (post-dedupe, in seq order). */
  onEnvelope: (envelope: WireEventEnvelope) => void;
  onConnected?: (agents: AgentInfo[]) => void;
  onDisconnected?: () => void;
  /** Tool round-trips from the agent's in-process deus MCP suite. The method
   *  arrives un-prefixed (exitPlanMode, getDiff, aap/list-apps, …). */
  onToolRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Session title pushed by the agent-server (claude SDK auto-summary). */
  onTitle: (payload: SideChannelTitle) => void;
}

/** Side-channel methods that dispatch into onToolRequest, keyed by wire name. */
const TOOL_REQUEST_METHODS: Record<string, string> = {
  [SIDE_CHANNEL.exitPlanMode]: "exitPlanMode",
  [SIDE_CHANNEL.askUserQuestion]: "askUserQuestion",
  [SIDE_CHANNEL.getDiff]: "getDiff",
  [SIDE_CHANNEL.diffComment]: "diffComment",
  [SIDE_CHANNEL.getTerminalOutput]: "getTerminalOutput",
  [SIDE_CHANNEL.getSimulatorContext]: "getSimulatorContext",
  [SIDE_CHANNEL.aapListApps]: "aap/list-apps",
  [SIDE_CHANNEL.aapLaunchApp]: "aap/launch-app",
  [SIDE_CHANNEL.aapStopApp]: "aap/stop-app",
  [SIDE_CHANNEL.aapReadAppSkill]: "aap/read-app-skill",
};

const SIDE_CHANNEL_REQUEST_TIMEOUT_MS = 30_000;

// ============================================================================
// AgentLink
// ============================================================================

export class AgentLink {
  private client: AgentServerClient | null = null;
  private sideChannel: SideChannelEndpoint | null = null;
  private connected = false;
  private agents: AgentInfo[] = [];
  private disposed = false;

  private constructor(private readonly options: AgentLinkOptions) {}

  /** Dial the agent-server; the returned link auto-reconnects on drop. */
  static async connect(options: AgentLinkOptions): Promise<AgentLink> {
    const link = new AgentLink(options);
    const client = await AgentServerClient.fromTransportFactory(() => link.openTransport(), {
      reconnect: true,
      // The agent-server lives and dies with the backend (managed spawn) —
      // never give up on our side; a dead child kills the backend anyway.
      maxReconnectAttempts: 10_000,
      reconnectDelayMs: 1_000,
      requestTimeoutMs: 30_000,
      clientInfo: { name: "deus-backend" },
    });
    link.client = client;
    try {
      client.onEvent(options.onEnvelope);
      const init = await client.initialize();
      link.agents = toAgentInfos(init);
    } catch (err) {
      // A failed handshake must not leak a dialing client (its reconnect loop
      // would keep the dead link alive) — the caller retries from scratch.
      await client.close().catch(() => {});
      link.client = null;
      throw err;
    }
    options.onConnected?.(link.agents);
    return link;
  }

  /** Build one connection: dial, wrap, claim side-channel frames. */
  private async openTransport(): Promise<LineTransport> {
    if (this.disposed) {
      throw new Error("agent link disposed");
    }
    const ws = await dialWebSocket(this.options.url);
    if (this.disposed) {
      ws.close();
      throw new Error("agent link disposed");
    }
    ws.on("error", () => {
      // A close event always follows; nothing to do here.
    });
    const transport = wsLineTransport(ws);

    const sideChannel = new SideChannelEndpoint((line) => transport.send(line), "backend");
    for (const [wireMethod, method] of Object.entries(TOOL_REQUEST_METHODS)) {
      sideChannel.onRequest(wireMethod, (params) => {
        if (!params || typeof params !== "object") {
          throw new Error(`${method} requires an object params payload`);
        }
        return this.options.onToolRequest(method, params as Record<string, unknown>);
      });
    }
    sideChannel.onNotification(SIDE_CHANNEL.title, (params) => {
      const payload = params as SideChannelTitle | undefined;
      if (payload?.sessionId && payload.title) this.options.onTitle(payload);
    });

    transport.onClose(() => {
      if (this.sideChannel === sideChannel) this.sideChannel = null;
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.options.onDisconnected?.();
    });

    this.sideChannel = sideChannel;
    this.connected = true;
    // Mark this connection as THE deus host for tool round-trips.
    sideChannel.notify(SIDE_CHANNEL.hello, {});

    return claimSideChannel(transport, sideChannel);
  }

  // ---- Standard wire ----

  /** Quick-ack turn start; completion arrives as the turn.ended event. */
  async startTurn(params: TurnStartParams): Promise<{ sessionId: string; turnId: string }> {
    return this.requireClient().startTurn(params);
  }

  /**
   * Cancel the session's active turn (idempotent). Returns the wire's single
   * outcome: `cancelled` (the harness confirmed), `unconfirmed` (dispatched
   * best-effort — turn.ended stays the source of truth) or `no_active_turn`.
   */
  async cancelTurn(sessionId: string): Promise<TurnCancelResult> {
    return this.requireClient().cancelTurn(sessionId);
  }

  // ---- Side channel (backend → agent-server) ----

  async providerAuth(params: { agentHarness: AgentHarness; cwd: string }): Promise<unknown> {
    return this.requireSideChannel().request(
      SIDE_CHANNEL.providerAuth,
      params,
      SIDE_CHANNEL_REQUEST_TIMEOUT_MS
    );
  }

  async aapRegisterMcp(serverName: string, url: string): Promise<void> {
    await this.requireSideChannel().request(
      SIDE_CHANNEL.aapRegisterMcp,
      { serverName, url },
      SIDE_CHANNEL_REQUEST_TIMEOUT_MS
    );
  }

  async aapUnregisterMcp(serverName: string): Promise<void> {
    await this.requireSideChannel().request(
      SIDE_CHANNEL.aapUnregisterMcp,
      { serverName },
      SIDE_CHANNEL_REQUEST_TIMEOUT_MS
    );
  }

  // ---- State ----

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  getAgents(): ReadonlyArray<AgentInfo> {
    return this.agents;
  }

  async close(): Promise<void> {
    this.disposed = true;
    await this.client?.close();
    this.client = null;
    this.sideChannel = null;
    this.connected = false;
  }

  private requireClient(): AgentServerClient {
    if (!this.client || this.disposed) {
      throw new Error("Agent link is not connected");
    }
    return this.client;
  }

  private requireSideChannel(): SideChannelEndpoint {
    if (!this.sideChannel || this.disposed) {
      throw new Error("Agent link is not connected (side channel unavailable)");
    }
    return this.sideChannel;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function dialWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`websocket connect failed: ${url}`));
    };
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    ws.on("open", onOpen);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

/**
 * Upstream initialize result → the settings surface. Only harnesses the engine
 * actually registered appear in `result.harnesses`, and their capabilities are
 * the NEGOTIATED ones — deus no longer fabricates a feature matrix that could
 * drift from what the engine will really do. Harnesses deus doesn't offer in
 * the composer (e.g. `acp`) are filtered out here, not renamed.
 */
function toAgentInfos(result: InitializeResult): AgentInfo[] {
  return Object.entries(result.harnesses).flatMap(([harness, capabilities]) => {
    const parsed = AgentHarnessSchema.safeParse(harness);
    return parsed.success ? [{ type: parsed.data, capabilities }] : [];
  });
}
