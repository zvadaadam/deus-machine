// backend/src/services/agent/service.ts
// Composition root for agent-server communication.
//
// Wires the AgentLink (standard wire + deus side channel) straight into the
// event handler: the engine's lifecycle envelopes go to persistence + WS push
// with nothing in between. No circular imports — this module imports from its
// dependencies, none of them import back.
//
// Dependency graph (all arrows point down, no cycles):
//
//   service (this file)
//       ├── client              (AgentLink: wire + side channel)
//       ├── event-handler       (factory: createAgentEventHandler)
//       ├── run-config          (turn params assembly)
//       └── tool-relay          (frontend RPC relay)
//
// Initialized once at startup in server.ts via agentService.init().

import path from "path";
import type { AgentHarness } from "@shared/enums";
import type { TurnCancelResult } from "@zvada/agent-server/protocol";
import type { ProviderAuthRequest, AgentInfo } from "@shared/agent-info";
import { AgentLink } from "./client";
import { createAgentEventHandler, type AgentEventHandler } from "./event-handler";
import { buildTurnStartParams, type DeusTurnOptions } from "./run-config";
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

// ---- Singleton ----

let link: AgentLink | null = null;
let events: AgentEventHandler | null = null;
let disposed = false;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Initialize the agent service. Call once at startup. Connects in the
 *  background and keeps retrying — same contract as the legacy client. */
export function init(agentServerUrl: string): void {
  if (link || events) {
    console.warn("[AgentService] Already initialized, skipping");
    return;
  }
  disposed = false;

  const handler = createAgentEventHandler();
  events = handler;

  void establishLink(agentServerUrl, handler);
}

async function establishLink(url: string, handler: AgentEventHandler): Promise<void> {
  for (let attempt = 0; !disposed; attempt++) {
    try {
      const connected = await AgentLink.connect({
        url,
        onEnvelope: (envelope) => handler.handle(envelope),
        onConnected: (agents) => {
          console.log(
            `[AgentService] Connected, agents: [${agents.map((a) => a.type).join(", ")}]`
          );
        },
        onDisconnected: () => {
          console.log("[AgentService] Disconnected from agent-server");
        },
        onToolRequest: (method, params) => handleToolRequest(method, params),
        onTitle: ({ sessionId, title }) => handler.handleTitle(sessionId, title),
      });
      // shutdown() may have run while the connect was in flight — a link
      // assigned now would outlive the service with its reconnect loop alive.
      if (disposed) {
        await connected.close();
        return;
      }
      link = connected;
      return;
    } catch (err) {
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      console.error(
        `[AgentService] Connect failed (${err instanceof Error ? err.message : err}); retrying in ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Gracefully shut down the agent link. */
export function shutdown(): void {
  disposed = true;
  void link?.close();
  link = null;
  events = null;
}

// ---- Public API ----

/**
 * Start a turn on the agent-server (quick-ack; completion arrives as the
 * turn.ended lifecycle event). Throws on rejection (WireRequestError with
 * typed codes) or when disconnected.
 */
export async function startTurn(
  sessionId: string,
  turnId: string,
  agentHarness: AgentHarness,
  prompt: string,
  options: DeusTurnOptions
): Promise<void> {
  if (!link) throw new Error("Agent service not initialized");
  const params = buildTurnStartParams(sessionId, turnId, agentHarness, prompt, {
    ...options,
    // Negotiated at the handshake, not guessed from a harness list.
    supportsImages:
      link.getAgents().find((a) => a.type === agentHarness)?.capabilities.images ?? false,
  });
  // Mirror the admission BEFORE the quick-ack round-trip: the server can push
  // the first envelopes in the same tick the ack line is processed, and the
  // handler must already know which turn is live then. beginTurn is a no-op
  // when the session is locally busy (the server will reject with turnActive)
  // — the live turn's state must not be clobbered by a doomed registration.
  const registered = events?.beginTurn(sessionId, turnId) ?? false;
  try {
    await link.startTurn(params);
  } catch (err) {
    if (registered) events?.abortTurn(sessionId, turnId);
    throw err;
  }
  // Server accepted a turn our local state thought was concurrent — the local
  // view was stale (e.g. backend restart); register for real now.
  if (!registered) events?.beginTurn(sessionId, turnId, { force: true });
}

/**
 * Cancel a session's active turn (best-effort, idempotent).
 *
 * The outcome is RETURNED, not swallowed: `unconfirmed` means the interrupt
 * was dispatched but never acknowledged, so the agent may still be writing
 * files. PROTOCOL §8 is explicit that this is not a cancel, and the caller has
 * to decide what the session's status becomes — `turn.ended` stays the source
 * of truth.
 */
export async function stopSession(params: { sessionId: string }): Promise<TurnCancelResult> {
  if (!link) throw new Error("Agent service not initialized");
  const result = await link.cancelTurn(params.sessionId);
  if (result.outcome === "unconfirmed") {
    console.warn(`[AgentService] cancel unconfirmed for session=${params.sessionId}`);
  }
  return result;
}

/** Check if the agent link is connected. */
export function isConnected(): boolean {
  return link?.isConnected() ?? false;
}

/** Check authentication status for an agent provider. */
export async function checkAuth(params: ProviderAuthRequest): Promise<unknown> {
  if (!link) throw new Error("Agent service not initialized");
  return link.providerAuth(params);
}

/** Returns the agents discovered during the initialize handshake. */
export function getAgents(): ReadonlyArray<AgentInfo> {
  return link?.getAgents() ?? [];
}

/** Register an AAP app's MCP server with the agent-server (mid-turn hot-swap). */
export async function registerAapMcp(serverName: string, url: string): Promise<void> {
  if (!link) throw new Error("Agent service not initialized");
  await link.aapRegisterMcp(serverName, url);
}

/** Unregister an AAP app's MCP server. */
export async function unregisterAapMcp(serverName: string): Promise<void> {
  if (!link) throw new Error("Agent service not initialized");
  await link.aapUnregisterMcp(serverName);
}

// ----------------------------------------------------------------------------
// Side-channel tool dispatch (agent-server → backend)
// ----------------------------------------------------------------------------

/** Handle one tool round-trip from the agent's in-process deus MCP suite. */
async function handleToolRequest(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  if (method.startsWith("aap/")) {
    return handleAapRpc(method, params);
  }

  // Simulator context is backend state — no frontend relay.
  if (method === "getSimulatorContext") {
    const sessionId = requireParam(params, "sessionId", method);
    return getContextForSession(sessionId);
  }

  const sessionId = requireParam(params, "sessionId", method);
  const requestId = crypto.randomUUID();
  const isUserFacing = method === "exitPlanMode" || method === "askUserQuestion";
  const sessionResources = ["workspaces", "sessions", "session", "stats"] as const;

  // User-facing methods: update session status so the sidebar shows
  // "needs input" instead of "working".
  if (method === "exitPlanMode") {
    const result = persistSessionNeedsPlanResponse(sessionId);
    if (result.ok) invalidate([...sessionResources], { sessionIds: [sessionId] });
  } else if (method === "askUserQuestion") {
    const result = persistSessionNeedsResponse(sessionId);
    if (result.ok) invalidate([...sessionResources], { sessionIds: [sessionId] });
  }

  try {
    return await relay({
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
 *  bad args or service errors — the side channel translates throws into
 *  error responses, which surface as `AAP error: …` in the tool result. */
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
