// backend/src/services/agent/client.ts
// The backend's link to the engine, which runs in this process
// (apps/agent-server): the standard @zvada/agent-server wire on an in-process
// channel, through AgentServerClient (typed quick-ack turns, per-session seq
// dedupe, gap healing via events/replay). The engine's deus MCP tools call the
// backend back (`onToolRequest`) and name sessions (`onTitle`).

import { AgentServerClient, type SessionEventGap } from "@zvada/agent-server/client";
import type {
  InitializeResult,
  TurnCancelResult,
  TurnStartParams,
} from "@zvada/agent-server/protocol";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import { AgentHarnessSchema } from "@shared/enums";
import type { AgentInfo } from "@shared/agent-info";
import {
  beforeCancel,
  beginTurnStart,
  startEngine,
  stopEngine,
  type SessionTitle,
} from "../../../../agent-server";

// ============================================================================
// Types
// ============================================================================

export interface AgentLinkOptions {
  /**
   * Every sequenced lifecycle envelope (post-dedupe, in seq order), Law-6
   * decoded: an event type — or a part — this build does not know arrives
   * preserved, not dropped, so the sink decides what to do with it.
   */
  onEnvelope: (envelope: DecodedWireEventEnvelope) => void;
  onEventGap?: (gap: SessionEventGap) => void;
  /** Tool round-trips from the agent's in-process deus MCP suite (getDiff,
   *  aap/list-apps, …). */
  onToolRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Session title from Claude's own summary. */
  onTitle: (payload: SessionTitle) => void;
}

// ============================================================================
// AgentLink
// ============================================================================

export class AgentLink {
  private closed = false;

  private constructor(
    private readonly client: AgentServerClient,
    private readonly agents: AgentInfo[]
  ) {}

  /** Start the engine and connect to it. */
  static async open(options: AgentLinkOptions): Promise<AgentLink> {
    const transport = startEngine({
      request: options.onToolRequest,
      title: options.onTitle,
    });
    try {
      const client = await AgentServerClient.attach(transport, {
        requestTimeoutMs: 30_000,
        clientInfo: { name: "deus-backend" },
      });
      client.onEvent(options.onEnvelope);
      if (options.onEventGap) client.onEventGap(options.onEventGap);
      const init = await client.initialize();
      // The backend is the engine's only client: it hears every session, not
      // only while a turn it started runs (wire protocol 6).
      await client.subscribeAll();
      return new AgentLink(client, toAgentInfos(init));
    } catch (err) {
      await stopEngine();
      throw err;
    }
  }

  /** Quick-ack turn start; completion arrives as the turn.ended event. */
  async startTurn(params: TurnStartParams): Promise<{ sessionId: string; turnId: string }> {
    const turn = beginTurnStart(params);
    try {
      return await this.client.startTurn(turn.params);
    } catch (err) {
      turn.refused();
      throw err;
    }
  }

  /**
   * Cancel the session's active turn (idempotent). Returns the wire's single
   * outcome: `cancelled` (the harness confirmed), `unconfirmed` (dispatched
   * best-effort — turn.ended stays the source of truth) or `no_active_turn`.
   */
  async cancelTurn(sessionId: string, turnId?: string): Promise<TurnCancelResult> {
    await beforeCancel(sessionId);
    return this.client.cancelTurn(sessionId, turnId);
  }

  /** The engine's own client, for what the standard wire carries beyond turns (logins). */
  get engine(): AgentServerClient {
    return this.client;
  }

  isConnected(): boolean {
    return !this.closed;
  }

  getAgents(): ReadonlyArray<AgentInfo> {
    return this.agents;
  }

  /** Close the client and stop the engine: turns under way are cancelled, the CLIs stopped. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } finally {
      await stopEngine();
    }
  }
}

/**
 * Initialize result → the settings surface. Only harnesses the engine
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
