// backend/src/services/agent/service.ts
// Composition root for agent-server communication.
//
// Wires the AgentLink (the engine, in this process, on the standard wire)
// straight into the event handler: the engine's lifecycle envelopes go to
// persistence + WS push with nothing in between. No circular imports — this
// module imports from its dependencies, none of them import back.
//
// Dependency graph (all arrows point down, no cycles):
//
//   service (this file)
//       ├── client              (AgentLink: the in-process engine)
//       ├── event-handler       (factory: createAgentEventHandler)
//       ├── run-config          (turn params assembly)
//       └── tool-relay          (frontend RPC relay)
//
// Initialized once at startup in server.ts via agentService.init().

import path from "path";
import type { AgentHarness } from "@shared/enums";
import type {
  ElicitationOutcome,
  ElicitationRequestedEvent,
  PermissionOutcome,
  PermissionRequestedEvent,
  TurnCancelResult,
} from "@zvada/agent-server/protocol";
import {
  allowOnce,
  askableQuestions,
  cardOutcome,
  cardQuestions,
  isPlanRequest,
  planAnswer,
} from "@shared/agent-asks";
import { isUnknownEvent } from "@shared/protocol-types";
import type { AgentInfo } from "@shared/agent-info";
import { registerAppMcp, unregisterAppMcp } from "../../../../agent-server";
import { AgentLink } from "./client";
import { LocalAgents } from "./local-agents";
import { initCloudDriver, shutdownCloudDriver } from "./cloud/driver";
import { createAgentEventHandler, type AgentEventHandler } from "./event-handler";
import { buildTurnStartParams, engineHarness, type DeusTurnOptions } from "./run-config";
import { relay } from "./tool-relay";
import { codexSessionHome, hasCodexSessionHome, resolveTurnApps } from "../integrations";
import {
  persistSessionNeedsPlanResponse,
  persistSessionNeedsResponse,
  persistSessionBackToWorking,
} from "./persistence";
import { invalidate } from "../query-engine";
import { getContextForSession } from "../simulator-context";
import { getRunningApps, launchApp, listApps, readAppSkill, stopApp } from "../aap";
import { handleAutomationToolRequest } from "../automations";
import { DB_PATH, getDatabase } from "../../lib/database";
import { getSessionRaw, getWorkspaceForMiddleware } from "../../db";
import { requireParam } from "../../lib/query-params";
import { computeWorkspacePath } from "../../middleware/workspace-loader";

// ---- Singleton ----

let link: AgentLink | null = null;
let localAgents: LocalAgents | null = null;
let events: AgentEventHandler | null = null;

/** Start the engine and connect the event handler to it. Call once at startup. */
export async function init(): Promise<void> {
  if (link || events) {
    console.warn("[AgentService] Already initialized, skipping");
    return;
  }
  const handler = createAgentEventHandler();
  events = handler;
  // Cloud sessions feed the SAME handler — one fold, one persistence path,
  // two transports.
  initCloudDriver(handler);

  link = await AgentLink.open({
    onEnvelope: (envelope) => {
      handler.handle(envelope);
      const { event } = envelope;
      if (isUnknownEvent(event)) return;
      if (event.type === "permission.requested") void answerPermission(event);
      if (event.type === "elicitation.requested") void answerElicitation(event);
    },
    onEventGap: (gap) => {
      const turnId = handler.handleEventGap(gap);
      if (!turnId || gap.reason !== "replay_failed") return;
      // Replay exhaustion can hide the native terminal entirely. One
      // targeted cancel reconciles it; a late reply cannot settle a successor.
      void (async () => {
        let confirmed = false;
        try {
          const result = await link?.cancelTurn(gap.sessionId, turnId);
          confirmed =
            result?.outcome === "cancelled" ||
            (result?.outcome === "no_active_turn" && !result.activeTurnId);
        } catch (error) {
          console.warn("[AgentService] Replay recovery cancel failed:", error);
        }
        handler.settleEventGap(gap.sessionId, turnId, confirmed);
      })();
    },
    onToolRequest: (method, params) => handleToolRequest(method, params),
    onTitle: ({ sessionId, title }) => handler.handleTitle(sessionId, title),
  });
  localAgents = new LocalAgents(link.engine);
  console.log(
    `[AgentService] Engine started, agents: [${link
      .getAgents()
      .map((a) => a.type)
      .join(", ")}]`
  );
}

/** Stop the engine: turns under way are cancelled, the agent CLIs stopped. */
export async function shutdown(): Promise<void> {
  shutdownCloudDriver();
  localAgents?.dispose();
  localAgents = null;
  const closing = link;
  link = null;
  events = null;
  await closing?.close();
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
  const apps = await turnApps(sessionId, agentHarness, options.resume);
  const params = buildTurnStartParams(sessionId, turnId, agentHarness, prompt, {
    ...options,
    ...apps,
    // Negotiated at the handshake, not guessed from a harness list.
    supportsImages:
      link.getAgents().find((a) => a.type === engineHarness(agentHarness))?.capabilities.images ??
      false,
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
  events?.confirmTurn(sessionId, turnId);
}

/**
 * The installed apps' MCP servers for a local turn: every project inherits
 * them. A Codex turn carries them only in a CODEX_HOME of its session's own,
 * so a new session gets one at its first turn with apps, and keeps it.
 */
async function turnApps(
  sessionId: string,
  agentHarness: AgentHarness,
  resume: string | undefined
): Promise<Pick<DeusTurnOptions, "mcpServers" | "env">> {
  const codex = engineHarness(agentHarness) === "codex-app-server";
  const { servers, skipped } = await resolveTurnApps();
  if (skipped.length) {
    console.log(
      `[AgentService] Apps not in this turn: ${skipped.map((s) => `${s.appId} (${s.reason})`).join(", ")}`
    );
  }
  if (!codex) return { mcpServers: servers, env: loopbackPastProxy() };
  if (!hasCodexSessionHome(sessionId)) {
    // A thread that began in the user's own home resumes there, without apps.
    if (!Object.keys(servers).length || resume) return {};
  }
  try {
    return {
      mcpServers: servers,
      env: { ...loopbackPastProxy(), CODEX_HOME: codexSessionHome(sessionId) },
    };
  } catch (error) {
    console.warn("[AgentService] Codex session home unavailable; turn runs without apps:", error);
    return {};
  }
}

/**
 * Apps with an account are reached at this backend's loopback gateway. Where
 * the user's environment sends HTTP through a proxy, the agent's MCP client
 * must not send loopback there: add it to NO_PROXY, keeping what they have.
 */
function loopbackPastProxy(): Record<string, string> {
  const proxied = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].some(
    (name) => process.env[name] || process.env[name.toLowerCase()]
  );
  if (!proxied) return {};
  const current = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const value = [
    ...new Set([...current.split(",").filter(Boolean), "127.0.0.1", "localhost"]),
  ].join(",");
  return { NO_PROXY: value, no_proxy: value };
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
export async function stopSession(params: {
  sessionId: string;
  turnId?: string;
}): Promise<TurnCancelResult> {
  if (!link) throw new Error("Agent service not initialized");
  const result = await link.cancelTurn(params.sessionId, params.turnId);
  if (params.turnId) {
    events?.settleEventGap(
      params.sessionId,
      params.turnId,
      result.outcome === "cancelled" ||
        (result.outcome === "no_active_turn" && !result.activeTurnId)
    );
  }
  if (result.outcome === "unconfirmed") {
    console.warn(`[AgentService] cancel unconfirmed for session=${params.sessionId}`);
  }
  return result;
}

/** Check if the agent link is connected. */
export function isConnected(): boolean {
  return link?.isConnected() ?? false;
}

/**
 * The turn the event handler believes is running for a session, if any.
 *
 * `undefined` means BOTH "no turn is live" and "there is no handler to ask"
 * (never initialized, or shut down) — callers must treat it as absence of
 * evidence, not as evidence of absence.
 */
export function liveTurnId(sessionId: string): string | undefined {
  return events?.liveTurnId(sessionId);
}

/**
 * What the engine asks Deus: a plan is the user's to approve, on the plan card
 * (`exitPlanMode`, as the UI knows it); a tool's approval is allowed.
 */
async function answerPermission(event: PermissionRequestedEvent): Promise<void> {
  const outcome = isPlanRequest(event.options) ? await askPlan(event) : allowOnce(event.options);
  try {
    await link?.engine.respondPermission(event.sessionId, event.requestId, outcome);
  } catch (error) {
    console.warn("[AgentService] Permission answer failed:", error);
  }
}

async function askPlan(event: PermissionRequestedEvent): Promise<PermissionOutcome> {
  try {
    const answer = (await handleToolRequest("exitPlanMode", {
      sessionId: event.sessionId,
      toolInput: event.toolCall?.rawInput ?? {},
    })) as { approved?: unknown } | undefined;
    return planAnswer(answer?.approved === true);
  } catch {
    // The card went away unanswered (the turn stopped, the relay was cleared).
    return { outcome: "cancelled" };
  }
}

/**
 * The agent's questions go to the question card (`askUserQuestion`, as the UI
 * knows it); what else an MCP server asks for (a form, a URL) Deus has no card
 * for, and declines.
 */
async function answerElicitation(event: ElicitationRequestedEvent): Promise<void> {
  const outcome = await askQuestions(event);
  try {
    await link?.engine.respondElicitation(event.sessionId, event.requestId, outcome);
  } catch (error) {
    console.warn("[AgentService] Question answer failed:", error);
  }
}

async function askQuestions(event: ElicitationRequestedEvent): Promise<ElicitationOutcome> {
  const questions = event.mode === "question" ? askableQuestions(event.questions) : [];
  if (questions.length === 0) return { action: "decline" };
  try {
    const answer = await handleToolRequest("askUserQuestion", {
      sessionId: event.sessionId,
      questions: cardQuestions(questions),
    });
    return cardOutcome(questions, answer);
  } catch {
    // The card went away unanswered (the turn stopped, the relay was cleared).
    return { action: "cancel" };
  }
}

/** The local agents' CLIs and logins, once the agent-server is connected. */
export function getLocalAgents(): LocalAgents {
  if (!localAgents) throw new Error("Agent server not connected");
  return localAgents;
}

/** Returns the agents discovered during the initialize handshake. */
export function getAgents(): ReadonlyArray<AgentInfo> {
  return link?.getAgents() ?? [];
}

/** Register an AAP app's MCP server with the engine (mid-turn hot-swap). */
export async function registerAapMcp(serverName: string, url: string): Promise<void> {
  if (!link) throw new Error("Agent service not initialized");
  await registerAppMcp(serverName, url);
}

/** Unregister an AAP app's MCP server. */
export async function unregisterAapMcp(serverName: string): Promise<void> {
  if (!link) throw new Error("Agent service not initialized");
  await unregisterAppMcp(serverName);
}

// ----------------------------------------------------------------------------
// Tool dispatch (the engine's deus MCP tools → backend)
// ----------------------------------------------------------------------------

/** Handle one tool round-trip from the agent's in-process deus MCP suite. */
async function handleToolRequest(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  if (method.startsWith("aap/")) {
    return handleAapRpc(method, params);
  }

  // Automations: answered entirely in the backend (no frontend relay) by the
  // SAME service the q:mutate arms use — one service, two callers.
  if (method === "automation/update") {
    return handleAutomationToolRequest(params);
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
