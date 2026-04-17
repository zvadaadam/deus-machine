// backend/src/services/agent/service.ts
// Composition root for agent-server communication.
//
// Creates the AgentClient, wires the event handler with injected dependencies,
// and exposes typed methods for other services to call. No circular imports —
// this module imports from its dependencies, none of them import back.
//
// Dependency graph (all arrows point down, no cycles):
//
//   service (this file)
//       ├── client              (WebSocket transport)
//       ├── event-handler       (factory: createAgentEventHandler)
//       └── tool-relay          (frontend RPC relay)
//
// Initialized once at startup in server.ts via agentService.init().

import { AgentClient } from "./client";
import { createAgentEventHandler } from "./event-handler";
import { relay } from "./tool-relay";
import {
  persistSessionNeedsPlanResponse,
  persistSessionNeedsResponse,
  persistSessionBackToWorking,
} from "./persistence";
import { invalidate } from "../query-engine";
import { getContextForSession } from "../simulator-context";
import type {
  TurnStartRequest,
  TurnStartResponse,
  TurnRespondRequest,
  SessionStopRequest,
  ProviderAuthRequest,
} from "@shared/agent-events";

// ---- Singleton ----

let client: AgentClient | null = null;

/** Initialize the agent service. Call once at startup. */
export function init(agentServerUrl: string): void {
  if (client) {
    console.warn("[AgentService] Already initialized, skipping");
    return;
  }

  client = new AgentClient({
    url: agentServerUrl,

    // Wire the event handler with respondToAgent injected — breaks the
    // circular dependency that previously existed between these modules.
    onEvent: createAgentEventHandler({
      respondToAgent: (params) => respondToAgent(params),
    }),

    onConnected: (agents) => {
      console.log(`[AgentService] Connected, agents: [${agents.map((a) => a.type).join(", ")}]`);
    },
    onDisconnected: () => {
      console.log("[AgentService] Disconnected from agent-server");
    },

    // Relay agent-server's frontend-facing RPC requests (browser, diff, plan)
    onFrontendRpc: async (requestId, sessionId, method, params) => {
      // Handle simulator context locally — the backend owns this state,
      // no need to relay to the frontend.
      if (method === "getSimulatorContext") {
        return getContextForSession(sessionId);
      }

      const isUserFacing = method === "exitPlanMode" || method === "askUserQuestion";
      const sessionResources = ["workspaces", "sessions", "session", "stats"] as const;

      // User-facing methods: update session status so sidebar shows "needs input" instead of "working"
      if (method === "exitPlanMode") {
        const result = persistSessionNeedsPlanResponse(sessionId);
        if (result.ok) invalidate([...sessionResources], { sessionIds: [sessionId] });
      } else if (method === "askUserQuestion") {
        const result = persistSessionNeedsResponse(sessionId);
        if (result.ok) invalidate([...sessionResources], { sessionIds: [sessionId] });
      }

      try {
        return await relay({
          type: "tool.request",
          requestId,
          sessionId,
          method,
          params,
          // User-facing methods wait indefinitely; auto-responding keep 2-min timeout
          timeoutMs: isUserFacing ? 24 * 60 * 60 * 1000 : 120_000,
        });
      } finally {
        if (isUserFacing) {
          const result = persistSessionBackToWorking(sessionId);
          if (result.ok) invalidate([...sessionResources], { sessionIds: [sessionId] });
        }
      }
    },
  });

  client.connect();
}

/** Gracefully shut down the agent client. */
export function shutdown(): void {
  client?.disconnect();
  client = null;
}

// ---- Public API (typed wrappers) ----

/** Forward a turn/start request to the agent-server. */
export async function forwardTurn(params: TurnStartRequest): Promise<TurnStartResponse> {
  if (!client) throw new Error("Agent service not initialized");
  return client.sendTurnStart(params);
}

/** Send a tool relay response back to the agent-server. */
export async function respondToAgent(params: TurnRespondRequest): Promise<void> {
  if (!client) throw new Error("Agent service not initialized");
  return client.sendTurnRespond(params);
}

/** Stop a session on the agent-server. */
export async function stopSession(params: SessionStopRequest): Promise<void> {
  if (!client) throw new Error("Agent service not initialized");
  return client.sendSessionStop(params);
}

/** Check if the agent service is connected. */
export function isConnected(): boolean {
  return client?.isConnected() ?? false;
}

/** Check authentication status for an agent provider. */
export async function checkAuth(params: ProviderAuthRequest): Promise<unknown> {
  if (!client) throw new Error("Agent service not initialized");
  return client.sendProviderAuth(params);
}

/** Returns the agents discovered during the initialize handshake. */
export function getAgents() {
  return client?.getAgents() ?? [];
}
