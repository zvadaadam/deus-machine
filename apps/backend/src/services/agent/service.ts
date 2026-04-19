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

import path from "path";
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
import { getRunningApps, launchApp, listApps, readAppSkill, stopApp } from "../aap";
import { DB_PATH, getDatabase } from "../../lib/database";
import { getSessionRaw, getWorkspaceForMiddleware } from "../../db";
import { requireParam } from "../../lib/query-params";
import { computeWorkspacePath } from "../../middleware/workspace-loader";
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

    // Handle AAP RPCs from the agent-server's deus-tools (list_apps,
    // launch_app, stop_app). These are server-to-server: we resolve against
    // apps.service directly, no frontend relay.
    onAapRpc: async (method, params) => {
      return handleAapRpc(method, params);
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

/**
 * Send an arbitrary outbound RPC to the agent-server. Returns the raw
 * response; callers are responsible for shape validation.
 *
 * Currently used by the AAP mcp-bridge to fire register/unregister RPCs
 * when an app transitions to ready / stops. If it grows more consumers
 * we'll split it out into typed wrappers — for now keep one generic.
 */
export async function sendRequestToAgent(method: string, params: unknown): Promise<unknown> {
  if (!client) throw new Error("Agent service not initialized");
  return client.sendRequest(method, params);
}

// ----------------------------------------------------------------------------
// AAP RPC dispatch
// ----------------------------------------------------------------------------

interface AapResolvedPaths {
  workspaceId: string;
  workspacePath: string;
  userDataDir: string;
}

/** Look up the workspaceId of the session the agent is running inside.
 *  The agent tool always has its `sessionId` in scope — we resolve to the
 *  workspace here so Claude never has to guess a workspaceId it doesn't
 *  know. Throws if the session isn't in the DB. */
function workspaceIdFromSessionId(sessionId: string): string {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) {
    throw new Error(`aap: session not found: ${sessionId}`);
  }
  return session.workspace_id;
}

/** Resolve a session (or explicit workspaceId) to the filesystem paths
 *  `apps.service.launchApp` needs. One helper for both the agent RPC
 *  path (uses sessionId) and the frontend q:command path (uses
 *  workspaceId) so they converge on identical inputs.
 *
 *  Exported for the user q:command path in `./commands`. */
export function resolveAapPaths(
  source: { workspaceId: string } | { sessionId: string }
): AapResolvedPaths {
  const userDataDir = path.dirname(DB_PATH);
  const workspaceId =
    "workspaceId" in source ? source.workspaceId : workspaceIdFromSessionId(source.sessionId);

  const db = getDatabase();
  const workspace = getWorkspaceForMiddleware(db, workspaceId);
  if (!workspace) {
    throw new Error(`aap: workspace not found: ${workspaceId}`);
  }
  const workspacePath = computeWorkspacePath(workspace);
  if (!workspacePath) {
    throw new Error(
      `aap: workspace ${workspaceId} has no resolvable path (missing root_path or slug)`
    );
  }
  return { workspaceId, workspacePath, userDataDir };
}

/** Handle an AAP RPC dispatched by the agent-server's deus-tools. Throws on
 *  bad args or service errors — the json-rpc-2.0 library translates throws
 *  into error responses, which surface as `AAP error: …` in the tool result. */
async function handleAapRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "aap/list-apps") {
    // The agent's workspace is resolved from its sessionId — Claude can't
    // know a workspaceId without being told, so the tool always carries
    // sessionId and we derive from it.
    const sessionId = requireParam(params, "sessionId", "aap/list-apps");
    const { workspaceId } = resolveAapPaths({ sessionId });
    return {
      apps: listApps(),
      runningAppIds: getRunningApps(workspaceId).map((r) => r.id),
    };
  }

  if (method === "aap/launch-app") {
    const appId = requireParam(params, "appId", "aap/launch-app");
    const sessionId = requireParam(params, "sessionId", "aap/launch-app");
    const { workspaceId, workspacePath, userDataDir } = resolveAapPaths({ sessionId });
    return launchApp({ appId, workspaceId, workspacePath, userDataDir });
  }

  if (method === "aap/stop-app") {
    const runningAppId = requireParam(params, "runningAppId", "aap/stop-app");
    await stopApp(runningAppId);
    return { success: true };
  }

  if (method === "aap/read-app-skill") {
    // Pure manifest-driven read — no running state required. Works against
    // any installed app whether or not it's currently launched, so Claude
    // can preview a skill before deciding to launch.
    const appId = requireParam(params, "appId", "aap/read-app-skill");
    return { content: readAppSkill(appId) };
  }

  throw new Error(`aap: unknown method "${method}"`);
}
