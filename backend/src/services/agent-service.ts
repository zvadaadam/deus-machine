// backend/src/services/agent-service.ts
// Singleton service for agent-server communication.
//
// Replaces the 3x "let fn = null; setFn()" callback wiring pattern with a
// single import point. Other services call agentService.forwardTurn() etc.
// directly — no callback registration needed.
//
// Initialized once at startup in server.ts via agentService.init().

import { AgentClient } from "./agent-client";
import { handleAgentEvent } from "./agent-event-handler";
import { relay } from "./tool-relay";
import type {
  TurnStartRequest,
  TurnStartResponse,
  TurnRespondRequest,
  SessionStopRequest,
} from "../../../shared/agent-events";

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
    onEvent: handleAgentEvent,
    onConnected: (agents) => {
      console.log(
        `[AgentService] Connected, agents: [${agents.map((a) => a.type).join(", ")}]`
      );
    },
    onDisconnected: () => {
      console.log("[AgentService] Disconnected from agent-server");
    },
    onFrontendRpc: async (requestId, sessionId, method, params) => {
      return relay({
        type: "tool.request",
        requestId,
        sessionId,
        method,
        params,
        timeoutMs: 120_000,
      });
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
export async function forwardTurn(
  params: TurnStartRequest
): Promise<TurnStartResponse> {
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
