// backend/src/services/agent/service.ts
// Composition root for agent-server communication.
//
// Wires AgentLink to the event handler for persistence and WS push, and relays
// the live turn's questions and plans. These modules have no circular imports.
//
//   queue → turns → service (this file)
//                     ├── client         (AgentLink: the in-process engine)
//                     ├── event-handler  (persistence and WS push)
//                     ├── run-config     (turn params assembly)
//                     └── tool-relay     (frontend RPC relay)
//
// Initialized once at startup in server.ts via agentService.init().

import type { AgentHarness } from "@shared/enums";
import { WireRequestError } from "@zvada/agent-server/client";
import type { HostToolSource } from "@zvada/agent-server/core";
import { echoMessageId, WIRE_ERROR_CODES } from "@zvada/agent-server/protocol";
import type {
  ElicitationOutcome,
  ElicitationRequestedEvent,
  Origin,
  PermissionOutcome,
  PermissionRequestedEvent,
  TurnCancelResult,
  TurnSteerParams,
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
import { hasAgentMessages } from "./agent-messages";
import { holdingTurn, wireTurn, forgetChatTurns, turnNotices } from "./chat-turn";
import { AgentLink } from "./client";
import { LocalAgents } from "./local-agents";
import { initCloudDriver, shutdownCloudDriver } from "./cloud/driver";
import { createAgentEventHandler, type AgentEventHandler, type TurnEnd } from "./event-handler";
import { buildTurnStartParams, withoutImageParts, type DeusTurnOptions } from "./run-config";
import { toolRequests } from "@shared/api/sessions";
import { cancelSessionRelays, isPrompt, pendingFor, relay } from "./tool-relay";
import { resolveTurnApps } from "../integrations";
import {
  persistSessionNeedsPlanResponse,
  persistSessionNeedsResponse,
  persistSessionBackToWorking,
  settleInterruptedSessions,
} from "./persistence";
import { invalidate } from "../query-engine";
import { openWith } from "../streams";
import { agentDeviceFor } from "../simulator-context";
import { setupForTurn } from "../project-environment.service";
import { handleAutomationToolRequest } from "../automations";
import { getDatabase } from "../../lib/database";
import {
  AgentServerDisconnectedError,
  DifferentTurnMessageError,
  NotFoundError,
} from "../../lib/errors";
import { requireParam } from "../../lib/query-params";

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
  // Before the engine can admit a turn: none of the turns the database still
  // shows as running survived the last process (see settleInterruptedSessions).
  const settled = settleInterruptedSessions();
  if (!settled.ok) {
    // Startup goes on: those chats stay as they were until someone stops them.
    console.error(
      "[AgentService] Could not settle the chats a restart interrupted:",
      settled.error
    );
  } else if (settled.value.length > 0) {
    console.log(`[AgentService] Settled ${settled.value.length} chat(s) a restart interrupted`);
    invalidate(["workspaces", "sessions", "session"], { sessionIds: settled.value });
  }
  turnNotices.interrupted = notifyTurnInterrupted;
  const handler = createAgentEventHandler();
  events = handler;
  // A client that starts following a chat while its agent waits on a question
  // or a plan (a window opened late, a phone) is shown it at once; one that
  // follows every chat (a window's card host) is shown every chat's.
  // Prompts only: a request a client answers by itself (a diff, a terminal's
  // output) was sent to the clients following then, and would run twice.
  openWith(toolRequests, ({ sessionId }) => {
    const pending = pendingFor(sessionId);
    return [
      { type: "pending" as const, requestIds: pending.map((request) => request.requestId) },
      ...pending
        .filter((request) => isPrompt(request.method))
        .map((request) => ({ type: "request" as const, request })),
    ];
  });
  // Cloud sessions feed the SAME handler — one fold, one persistence path,
  // two transports.
  initCloudDriver(handler);

  link = await AgentLink.open({
    onEnvelope: (envelope) => {
      const { event, sessionId } = envelope;
      const known = !isUnknownEvent(event);
      // Withdraw this turn's cards before publishing its end and admitting its successor.
      if (known && event.type === "turn.ended")
        cancelSessionRelays(sessionId, "turn ended", event.turnId);
      const end = handler.handle(envelope);
      if (!known) return;
      if (end) turnWatcher?.turnEnded(end);
      if (event.type === "message.started" && event.role === "user" && event.steerId !== undefined)
        turnWatcher?.userEcho(sessionId, event.turnId, event.steerId);
      // The sending head stays until its text is published. A message end carries only ids.
      if (event.type === "message.ended" && event.messageId === echoMessageId(event.turnId))
        turnWatcher?.userEcho(sessionId, event.turnId);
      if (event.type === "permission.requested") void answerPermission(event);
      if (event.type === "elicitation.requested") void answerElicitation(event);
    },
    onEventGap: (gap) => {
      const turnId = handler.handleEventGap(gap);
      if (!turnId || gap.reason !== "replay_failed") return;
      // Replay exhaustion can hide the native terminal entirely. One
      // targeted cancel reconciles it; a late reply cannot settle a successor.
      void (async () => {
        const result = await link?.cancelTurn(gap.sessionId, turnId).catch((error: unknown) => {
          console.warn("[AgentService] Replay recovery cancel failed:", error);
        });
        const absent = result?.outcome === "no_active_turn";
        const gone = result?.outcome === "cancelled" || (absent && !result.activeTurnId);
        handler.settleEventGap(gap.sessionId, turnId, gone, absent ? undefined : "cancelled");
      })();
    },
    onToolRequest: (method, params) => handleToolRequest(method, params),
    // Every chat here can operate the others (LLP 0019), through the engine's delivery.
    sessionTools: (own) => sessionTools?.(own) ?? own,
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
  forgetChatTurns();
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
  options: Omit<DeusTurnOptions, "agentMessages"> & { signal?: AbortSignal }
): Promise<void> {
  if (!link) throw new Error("Agent service not initialized");
  const { signal, ...run } = options;
  signal?.throwIfAborted();
  const stopped = Promise.withResolvers<never>();
  const onAbort = () => stopped.reject(signal?.reason);
  signal?.addEventListener("abort", onAbort);
  const apps = await Promise.race([turnApps(agentHarness), stopped.promise]).finally(() =>
    signal?.removeEventListener("abort", onAbort)
  );
  // Stop can arrive after the apps resolve and before this turn is registered.
  signal?.throwIfAborted();
  if (!getDatabase().prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) {
    throw new NotFoundError("This chat no longer exists.");
  }
  const device = agentDeviceFor(sessionId);
  const params = buildTurnStartParams(sessionId, turnId, agentHarness, prompt, {
    ...run,
    ...apps,
    agentMessages: hasAgentMessages(sessionId),
    setup: setupForTurn(sessionId),
    agentDeviceSession: device.session,
    simulator: device.udid ? { udid: device.udid } : null,
    // Negotiated at the handshake, not guessed from a harness list.
    supportsImages: supportsImages(agentHarness),
  });
  signal?.throwIfAborted();
  if (wireTurn(sessionId, turnId)) events?.resetTurnFacts(sessionId);
  await link.startTurn(params);
}

function supportsImages(harness: string): boolean {
  return link?.getAgents().find((a) => a.type === harness)?.capabilities.images ?? false;
}

export async function steerTurn(harness: string, params: TurnSteerParams) {
  if (!link) throw new AgentServerDisconnectedError();
  try {
    return await link.engine.steerTurn({
      ...params,
      input: supportsImages(harness) ? params.input : withoutImageParts(params.input),
    });
  } catch (error) {
    if (error instanceof WireRequestError && error.code === WIRE_ERROR_CODES.turnConflict)
      throw new DifferentTurnMessageError();
    throw error;
  }
}

/**
 * The installed apps' MCP servers for a local turn: every project inherits
 * them. Codex gets them in its thread's own config, under names its user's
 * own configuration does not have (`appServerName`). The chat's Deus tools
 * are the engine's to deliver (`hostTools`).
 */
async function turnApps(
  harness: AgentHarness
): Promise<Pick<DeusTurnOptions, "mcpServers" | "env">> {
  const { servers, skipped } = await resolveTurnApps(harness);
  if (skipped.length) {
    console.log(
      `[AgentService] Apps not in this turn: ${skipped.map((s) => `${s.appId} (${s.reason})`).join(", ")}`
    );
  }
  return { mcpServers: servers, env: loopbackPastProxy() };
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
  if (result.outcome === "cancelled")
    cancelSessionRelays(params.sessionId, "turn stopped", result.turnId);
  if (result.outcome === "unconfirmed") {
    console.warn(`[AgentService] cancel unconfirmed for session=${params.sessionId}`);
  }
  return result;
}

/** Check if the agent link is connected. */
export function isConnected(): boolean {
  return link?.isConnected() ?? false;
}

/** A chat's tools beside the Deus tools: the operator's, registered by services/assistants. */
let sessionTools: ((own: HostToolSource) => HostToolSource) | undefined;
export function provideSessionTools(compose: (own: HostToolSource) => HostToolSource): void {
  sessionTools = compose;
}

export type InterruptionCause = "failure" | "cancelled";
export type StopAsked = { by: Origin; turnId?: string; endedAt?: number };
interface TurnWatcher {
  turnEnded(end: TurnEnd): void;
  startCleared(sessionId: string): void;
  userEcho(sessionId: string, turnId: string, steerId?: string): void;
  stopAsked(sessionId: string, stop: StopAsked): void;
  interrupted(
    sessionId: string,
    turnId: string | undefined,
    gone: boolean,
    cause: InterruptionCause
  ): string[] | undefined;
}
let turnWatcher: TurnWatcher | undefined;
export function provideTurnWatcher(watcher: TurnWatcher): void {
  turnWatcher = watcher;
}

export function notifyStopAsked(sessionId: string, stop: StopAsked): void {
  turnWatcher?.stopAsked(sessionId, stop);
}

export const notifyStartCleared = (sessionId: string) => turnWatcher?.startCleared(sessionId);

export function notifyTurnInterrupted(
  sessionId: string,
  turnId: string | undefined,
  gone: boolean,
  cause: InterruptionCause = "failure"
) {
  if (gone && turnId) cancelSessionRelays(sessionId, "turn interrupted", turnId);
  return turnWatcher?.interrupted(sessionId, turnId, gone, cause);
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
  if (event.turnId !== holdingTurn(event.sessionId)?.turnId) return { outcome: "cancelled" };
  try {
    const answer = (await handleToolRequest("exitPlanMode", {
      sessionId: event.sessionId,
      toolInput: event.toolCall?.rawInput ?? {},
    })) as { approved?: unknown; feedback?: unknown } | undefined;
    const feedback = typeof answer?.feedback === "string" ? answer.feedback.trim() : "";
    return planAnswer(answer?.approved === true, feedback || undefined);
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
  if (event.turnId !== holdingTurn(event.sessionId)?.turnId) return { action: "cancel" };
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
  if (!localAgents) throw new AgentServerDisconnectedError();
  return localAgents;
}

// ----------------------------------------------------------------------------
// Tool dispatch (the engine's deus MCP tools → backend)
// ----------------------------------------------------------------------------

/** Handle one tool round-trip from the agent's in-process deus MCP suite. */
async function handleToolRequest(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  // Automations: answered entirely in the backend (no frontend relay) by the
  // SAME service the q:mutate arms use — one service, two callers.
  if (method === "automation/update") {
    return handleAutomationToolRequest(params);
  }
  // A simulator recording joins the workspace's agent-device session.
  if (method === "agentDevice") return agentDeviceFor(requireParam(params, "sessionId", method));

  const sessionId = requireParam(params, "sessionId", method);
  const turnId = holdingTurn(sessionId)?.turnId;
  const requestId = crypto.randomUUID();
  const isUserFacing = isPrompt(method);
  const sessionResources = ["workspaces", "sessions", "session"] as const;

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
      turnId,
      method,
      params,
      // User-facing methods wait indefinitely; auto-responding keep 2-min timeout
      timeoutMs: isUserFacing ? 24 * 60 * 60 * 1000 : 120_000,
    });
  } finally {
    if (isUserFacing && turnId !== undefined && holdingTurn(sessionId)?.turnId === turnId) {
      const result = persistSessionBackToWorking(sessionId);
      if (result.ok) invalidate([...sessionResources], { sessionIds: [sessionId] });
    }
  }
}
