// agent-server/event-broadcaster.ts
// Singleton facade that broadcasts JSON-RPC notifications to all connected
// clients (backend, monitoring tools, etc.) via WebSocket.
// Manages connection lifecycle (attach/detach tunnels) and exposes typed
// methods for canonical agent events.

import type { RpcConnection } from "./rpc-connection";
import { FRONTEND_NOTIFICATIONS, FRONTEND_RPC_METHODS } from "./protocol";
import { AGENT_EVENT_NAMES } from "@shared/agent-events";
import type { AgentEvent, InteractionRequestType } from "@shared/agent-events";
import type { AgentHarness, ErrorCategory } from "@shared/enums";
import type { FinishReason, Part, TokenUsage } from "@shared/messages";
import type { PartEvent } from "./messages/adapter";
import type {
  MessageResponse,
  ErrorResponse,
  EnterPlanModeNotification,
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  GetDiffRequest,
  GetDiffResponse,
  DiffCommentRequest,
  DiffCommentResponse,
  GetTerminalOutputRequest,
  GetTerminalOutputResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ListAppsRequest,
  ListAppsResponse,
  LaunchAppRequest,
  LaunchAppResponse,
  StopAppRequest,
  StopAppResponse,
  ReadAppSkillRequest,
  ReadAppSkillResponse,
} from "./protocol";

// ============================================================================
// Timeout defaults (milliseconds)
// ============================================================================

/** Timeout for user-facing requests that require human interaction.
 *  2 minutes allows users time to read multi-option questions and deliberate.
 *  There is no UI countdown, so this must be generous. */
const USER_FACING_TIMEOUT_MS = 120_000;

/** Timeout for data-fetching requests that should resolve quickly */
const DATA_QUERY_TIMEOUT_MS = 10_000;

/** Timeout for AAP `launch_app`. The manifest's ready-probe caps at 30s and
 *  the backend adds probe-setup + storage-dir work on top. 60s keeps first-
 *  time launches (binary not yet downloaded) from tripping the tunnel timeout
 *  while still bounded. */
const AAP_LAUNCH_TIMEOUT_MS = 60_000;

// ============================================================================
// EventBroadcaster class
// ============================================================================

class EventBroadcasterClass {
  // Multi-tunnel: all connected clients receive notifications.
  // The relay and desktop app can be connected simultaneously.
  private tunnels = new Set<RpcConnection>();

  attachTunnel(tunnel: RpcConnection): void {
    this.tunnels.add(tunnel);
    console.log(`[EventBroadcaster] Tunnel attached (${this.tunnels.size} active)`);
  }

  /**
   * Detach a specific tunnel. If tunnel is provided, removes only that one.
   * If no tunnel is provided, clears all tunnels.
   */
  detachTunnel(tunnel?: RpcConnection): void {
    if (tunnel) {
      this.tunnels.delete(tunnel);
      console.log(`[EventBroadcaster] Tunnel detached (${this.tunnels.size} remaining)`);
    } else {
      this.tunnels.clear();
      console.log("[EventBroadcaster] All tunnels cleared");
    }
  }

  // ==========================================================================
  // OUTGOING NOTIFICATIONS (agent-server -> frontend)
  // ==========================================================================

  sendMessage(response: MessageResponse): void {
    this.broadcastNotification(FRONTEND_NOTIFICATIONS.MESSAGE, response, "sendMessage");
  }

  sendError(response: ErrorResponse): void {
    this.broadcastNotification(FRONTEND_NOTIFICATIONS.QUERY_ERROR, response, "sendError");
  }

  sendEnterPlanModeNotification(response: EnterPlanModeNotification): void {
    this.broadcastNotification(
      FRONTEND_NOTIFICATIONS.ENTER_PLAN_MODE,
      response,
      "sendEnterPlanModeNotification"
    );
  }

  // ==========================================================================
  // CANONICAL EVENT EMISSION (agent-server protocol — dual-write period)
  //
  // These methods emit provider-neutral events defined in shared/agent-events.ts
  // as JSON-RPC notifications to all connected tunnels. During the dual-write
  // period, both the old notifications (sendMessage/sendError/etc.) and these
  // canonical events are emitted simultaneously.
  // ==========================================================================

  /** Generic emit: broadcasts a canonical AgentEvent as a JSON-RPC notification. */
  emitEvent(event: AgentEvent): void {
    this.broadcastNotification(event.type, event, `emitEvent(${event.type})`);
  }

  // --- Session lifecycle ---

  emitSessionStarted(sessionId: string, agentHarness: AgentHarness): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_STARTED,
      sessionId,
      agentHarness,
    });
  }

  emitSessionIdle(sessionId: string, agentHarness: AgentHarness): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_IDLE,
      sessionId,
      agentHarness,
    });
  }

  emitSessionError(
    sessionId: string,
    agentHarness: AgentHarness,
    error: string,
    category: ErrorCategory
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_ERROR,
      sessionId,
      agentHarness,
      error,
      category,
    });
  }

  emitSessionCancelled(sessionId: string, agentHarness: AgentHarness): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_CANCELLED,
      sessionId,
      agentHarness,
    });
  }

  // --- Messages ---

  emitSystemMessage(sessionId: string, agentHarness: AgentHarness, data: unknown): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.MESSAGE_SYSTEM,
      sessionId,
      agentHarness,
      data,
    });
  }

  emitAssistantMessage(
    sessionId: string,
    agentHarness: AgentHarness,
    message: {
      id: string;
      role: "assistant";
      content: unknown;
      stop_reason?: string | null;
      parent_tool_use_id?: string | null;
    },
    model?: string
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.MESSAGE_ASSISTANT,
      sessionId,
      agentHarness,
      message,
      ...(model ? { model } : {}),
    });
  }

  emitToolResultMessage(
    sessionId: string,
    agentHarness: AgentHarness,
    message: { id: string; role: "user"; content: unknown; parent_tool_use_id?: string | null },
    model?: string
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.MESSAGE_TOOL_RESULT,
      sessionId,
      agentHarness,
      message,
      ...(model ? { model } : {}),
    });
  }

  emitMessageResult(
    sessionId: string,
    agentHarness: AgentHarness,
    subtype: string,
    usage?: unknown
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.MESSAGE_RESULT,
      sessionId,
      agentHarness,
      subtype,
      ...(usage !== undefined ? { usage } : {}),
    });
  }

  emitMessageCancelled(sessionId: string, agentHarness: AgentHarness): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.MESSAGE_CANCELLED,
      sessionId,
      agentHarness,
    });
  }

  // --- Turn & part lifecycle ---

  /** Dispatch a single PartEvent from an adapter. */
  emitPartEvent(
    sessionId: string,
    agentHarness: AgentHarness,
    messageId: string,
    event: PartEvent
  ): void {
    switch (event.type) {
      case "turn.started":
        this.emitEvent({
          type: AGENT_EVENT_NAMES.TURN_STARTED,
          sessionId,
          agentHarness,
          messageId,
          turnId: event.turnId,
        });
        break;
      case "message.created":
        this.emitEvent({
          type: AGENT_EVENT_NAMES.MESSAGE_CREATED,
          sessionId,
          agentHarness,
          messageId: event.messageId,
          role: event.role,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        });
        break;
      case "part.created":
        this.emitEvent({
          type: AGENT_EVENT_NAMES.PART_CREATED,
          sessionId,
          agentHarness,
          messageId: event.part.messageId,
          partId: event.part.id,
          part: event.part,
        });
        break;
      case "part.delta":
        this.emitEvent({
          type: AGENT_EVENT_NAMES.PART_DELTA,
          sessionId,
          agentHarness,
          partId: event.partId,
          delta: event.delta,
        });
        break;
      case "part.done":
        this.emitEvent({
          type: AGENT_EVENT_NAMES.PART_DONE,
          sessionId,
          agentHarness,
          messageId: event.part.messageId,
          partId: event.part.id,
          part: event.part,
        });
        break;
      case "message.done":
        this.emitEvent({
          type: AGENT_EVENT_NAMES.MESSAGE_DONE,
          sessionId,
          agentHarness,
          messageId: event.messageId,
          ...(event.stopReason ? { stopReason: event.stopReason } : {}),
          parts: event.parts,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        });
        break;
      case "turn.completed":
        this.emitEvent({
          type: AGENT_EVENT_NAMES.TURN_COMPLETED,
          sessionId,
          agentHarness,
          messageId,
          turnId: event.turnId,
          ...(event.finishReason ? { finishReason: event.finishReason } : {}),
          ...(event.tokens ? { tokens: event.tokens } : {}),
          ...(event.cost != null ? { cost: event.cost } : {}),
        });
        break;
    }
  }

  // --- Interaction requests ---

  emitRequestOpened(
    requestId: string,
    sessionId: string,
    agentHarness: AgentHarness,
    requestType: InteractionRequestType,
    data: unknown
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.REQUEST_OPENED,
      requestId,
      sessionId,
      agentHarness,
      requestType,
      data,
    });
  }

  // --- Tool relay ---

  emitToolRequest(
    requestId: string,
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.TOOL_REQUEST,
      requestId,
      sessionId,
      method,
      params,
      timeoutMs,
    });
  }

  // --- Metadata ---

  emitSessionTitle(sessionId: string, agentHarness: AgentHarness, title: string): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_TITLE,
      sessionId,
      agentHarness,
      title,
    });
  }

  emitAgentSessionId(sessionId: string, agentSessionId: string): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.AGENT_SESSION_ID,
      sessionId,
      agentSessionId,
    });
  }

  // ==========================================================================
  // OUTGOING REQUESTS (agent-server -> frontend)
  // User-facing requests (plan approval, questions) wait indefinitely —
  // the user may close the laptop and return later. Only data-fetch
  // requests use timeouts.
  // ==========================================================================

  // --- User-facing RPCs (no timeout) ---
  requestExitPlanMode(r: ExitPlanModeRequest) {
    return this.requireTunnel().request(
      FRONTEND_RPC_METHODS.EXIT_PLAN_MODE,
      r
    ) as Promise<ExitPlanModeResponse>;
  }
  requestAskUserQuestion(r: AskUserQuestionRequest) {
    return this.requireTunnel().request(
      FRONTEND_RPC_METHODS.ASK_USER_QUESTION,
      r
    ) as Promise<AskUserQuestionResponse>;
  }
  requestGetDiff(r: GetDiffRequest) {
    return this.rpc<GetDiffResponse>(FRONTEND_RPC_METHODS.GET_DIFF, r, DATA_QUERY_TIMEOUT_MS);
  }
  requestDiffComment(r: DiffCommentRequest) {
    return this.rpc<DiffCommentResponse>(
      FRONTEND_RPC_METHODS.DIFF_COMMENT,
      r,
      DATA_QUERY_TIMEOUT_MS
    );
  }
  requestGetTerminalOutput(r: GetTerminalOutputRequest) {
    return this.rpc<GetTerminalOutputResponse>(
      FRONTEND_RPC_METHODS.GET_TERMINAL_OUTPUT,
      r,
      DATA_QUERY_TIMEOUT_MS
    );
  }

  // --- AAP (Agentic Apps) RPCs (handled by backend's apps.service) ---
  //
  // Method names are stringly-typed because FRONTEND_RPC_METHODS is a frozen
  // enum canonical in shared/agent-events. AAP methods target the backend
  // directly (not forwarded to frontend), so they don't belong there.
  requestListApps(r: ListAppsRequest): Promise<ListAppsResponse> {
    return this.rpc<ListAppsResponse>("aap/list-apps", r, DATA_QUERY_TIMEOUT_MS);
  }
  requestLaunchApp(r: LaunchAppRequest): Promise<LaunchAppResponse> {
    // Bumped timeout: first-ever launch may need to download/compile a binary.
    return this.rpc<LaunchAppResponse>("aap/launch-app", r, AAP_LAUNCH_TIMEOUT_MS);
  }
  requestStopApp(r: StopAppRequest): Promise<StopAppResponse> {
    return this.rpc<StopAppResponse>("aap/stop-app", r, DATA_QUERY_TIMEOUT_MS);
  }
  requestReadAppSkill(r: ReadAppSkillRequest): Promise<ReadAppSkillResponse> {
    return this.rpc<ReadAppSkillResponse>("aap/read-app-skill", r, DATA_QUERY_TIMEOUT_MS);
  }

  // --- Simulator context RPC (handled by backend, not forwarded to frontend) ---

  /**
   * Query the backend for the simulator UDID assigned to this session's workspace.
   * The backend handles this directly from its in-memory simulator context map.
   * Returns null if no simulator is assigned to the workspace.
   */
  requestSimulatorContext(r: {
    sessionId: string;
  }): Promise<{ udid: string; port?: number; streaming: boolean } | null> {
    return this.rpc<{ udid: string; port?: number; streaming: boolean } | null>(
      "getSimulatorContext",
      r,
      DATA_QUERY_TIMEOUT_MS
    );
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  /** Generic typed RPC: send a request to the frontend with a timeout. */
  private async rpc<TRes>(method: string, params: unknown, timeoutMs: number): Promise<TRes> {
    return this.withTimeout<TRes>(
      this.requireTunnel().request(method, params) as Promise<TRes>,
      timeoutMs,
      method
    );
  }

  /** Returns the first available tunnel, or throws if none are connected. */
  private requireTunnel(): RpcConnection {
    const first = this.tunnels.values().next().value;
    if (!first) {
      throw new Error("EventBroadcaster tunnel not attached.");
    }
    return first;
  }

  /**
   * Broadcast a notification to all connected tunnels.
   * Dead tunnels (those that throw on notify) are automatically removed.
   */
  private broadcastNotification(method: string, params: unknown, label: string): void {
    const t0 = Date.now();
    for (const tunnel of this.tunnels) {
      try {
        tunnel.notify(method, params);
      } catch (err) {
        console.error(`[EventBroadcaster] ${label} failed, removing dead tunnel:`, err);
        this.tunnels.delete(tunnel);
      }
    }
    const elapsed = Date.now() - t0;
    if (elapsed > 5) {
      console.log(
        `[TIMING][EventBroadcaster] ${label} broadcast took ${elapsed}ms (${this.tunnels.size} tunnels)`
      );
    }
  }

  /**
   * Race a tunnel request against a timeout. Rejects with a descriptive
   * error if the frontend does not respond within `ms` milliseconds.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(
          new Error(
            `[EventBroadcaster] ${label} timed out after ${ms}ms -- frontend did not respond`
          )
        );
      }, ms);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timerId !== undefined) clearTimeout(timerId);
    });
  }
}

/** Singleton instance shared across the entire agent-server process */
export const EventBroadcaster = new EventBroadcasterClass();
