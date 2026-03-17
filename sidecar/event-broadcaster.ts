// sidecar/event-broadcaster.ts
// Singleton facade that broadcasts JSON-RPC notifications to all connected
// clients (backend, monitoring tools, etc.) via the WebSocket transport.
// Manages connection lifecycle (attach/detach tunnels) and exposes typed
// methods for canonical agent events and legacy notification formats.

import type { RpcConnection } from "./rpc-connection";
import { FRONTEND_NOTIFICATIONS, FRONTEND_RPC_METHODS } from "./protocol";
import { AGENT_EVENT_NAMES } from "../shared/agent-events";
import type { AgentEvent, InteractionRequestType } from "../shared/agent-events";
import type { AgentType, ErrorCategory } from "../shared/enums";
import type {
  MessageResponse,
  ErrorResponse,
  EnterPlanModeNotification,
  StatusChangedNotification,
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
  BrowserSnapshotRequest,
  BrowserSnapshotResponse,
  BrowserClickRequest,
  BrowserClickResponse,
  BrowserTypeRequest,
  BrowserTypeResponse,
  BrowserNavigateRequest,
  BrowserNavigateResponse,
  BrowserGetStateRequest,
  BrowserGetStateResponse,
  BrowserWaitForRequest,
  BrowserWaitForResponse,
  BrowserEvaluateRequest,
  BrowserEvaluateResponse,
  BrowserPressKeyRequest,
  BrowserPressKeyResponse,
  BrowserHoverRequest,
  BrowserHoverResponse,
  BrowserSelectOptionRequest,
  BrowserSelectOptionResponse,
  BrowserNavigateBackRequest,
  BrowserNavigateBackResponse,
  BrowserConsoleMessagesRequest,
  BrowserConsoleMessagesResponse,
  BrowserNetworkRequestsRequest,
  BrowserNetworkRequestsResponse,
  BrowserScreenshotRequest,
  BrowserScreenshotResponse,
  BrowserScrollRequest,
  BrowserScrollResponse,
  SimScreenshotRequest,
  SimScreenshotResponse,
  SimTapRequest,
  SimTapResponse,
  SimSwipeRequest,
  SimSwipeResponse,
  SimTypeTextRequest,
  SimTypeTextResponse,
  SimPressKeyRequest,
  SimPressKeyResponse,
  SimBuildAndRunRequest,
  SimBuildAndRunResponse,
  SimListDevicesRequest,
  SimListDevicesResponse,
  SimStartRequest,
  SimStartResponse,
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

/** Timeout for browser snapshot — the accessibility tree builder on heavy
 *  pages can take up to 15s (evalWithResult timeout), plus IPC overhead. */
const BROWSER_SNAPSHOT_TIMEOUT_MS = 20_000;

/** Timeout for browser navigate — allows extra time for auto-creating a tab,
 *  waiting for the webview to initialize, loading the page, and taking a snapshot. */
const BROWSER_NAVIGATE_TIMEOUT_MS = 30_000;

/** Timeout for browser navigate-back — page load (15s) + snapshot (12s) + buffer. */
const BROWSER_NAVIGATE_BACK_TIMEOUT_MS = 30_000;

/** Timeout for BrowserWaitFor — polls for up to 30s inside the webview,
 *  plus 5s buffer for eval overhead and title-channel round-trip. */
const BROWSER_WAIT_FOR_TIMEOUT_MS = 35_000;

/** Timeout for BrowserEvaluate — user code can run expensive operations,
 *  frontend allows 15s for eval, plus IPC overhead. */
const BROWSER_EVALUATE_TIMEOUT_MS = 20_000;

/** Timeout for BrowserScreenshot — native WKWebView.takeSnapshot() has a
 *  10s internal timeout, plus 5s buffer for IPC and base64 encoding. */
const BROWSER_SCREENSHOT_TIMEOUT_MS = 15_000;

/** Timeout for browser interactions (click, type, hover, etc.) that include
 *  visual effects + eval. Visual cursor animation up to 3s + eval up to 8s. */
const BROWSER_INTERACTION_TIMEOUT_MS = 15_000;

/** Timeout for simulator screenshot — Rust ObjC bridge capture + JPEG
 *  encoding + base64 transfer. Typically <2s but allow headroom. */
const SIMULATOR_SCREENSHOT_TIMEOUT_MS = 10_000;

/** Timeout for simulator interactions (tap, swipe, type, key press) — HID
 *  injection through the ObjC bridge is fast but include IPC buffer. */
const SIMULATOR_INTERACTION_TIMEOUT_MS = 10_000;

/** Timeout for simulator boot — booting a simulator and starting the MJPEG
 *  stream + ObjC bridge can take 15-20s on cold boot. */
const SIMULATOR_BOOT_TIMEOUT_MS = 30_000;

/** Timeout for build-and-run — xcodebuild can take minutes for large projects.
 *  10 minutes matches the existing builder.ts timeout. */
const SIMULATOR_BUILD_TIMEOUT_MS = 600_000;

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
  // OUTGOING NOTIFICATIONS (sidecar -> frontend)
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

  sendStatusChanged(notification: StatusChangedNotification): void {
    this.broadcastNotification(
      FRONTEND_NOTIFICATIONS.STATUS_CHANGED,
      notification,
      "sendStatusChanged"
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

  emitSessionStarted(sessionId: string, agentType: AgentType): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_STARTED,
      sessionId,
      agentType,
    });
  }

  emitSessionIdle(sessionId: string, agentType: AgentType): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_IDLE,
      sessionId,
      agentType,
    });
  }

  emitSessionError(
    sessionId: string,
    agentType: AgentType,
    error: string,
    category: ErrorCategory
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_ERROR,
      sessionId,
      agentType,
      error,
      category,
    });
  }

  emitSessionCancelled(sessionId: string, agentType: AgentType): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.SESSION_CANCELLED,
      sessionId,
      agentType,
    });
  }

  // --- Messages ---

  emitAssistantMessage(
    sessionId: string,
    agentType: AgentType,
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
      agentType,
      message,
      ...(model ? { model } : {}),
    });
  }

  emitToolResultMessage(
    sessionId: string,
    agentType: AgentType,
    message: { id: string; role: "user"; content: unknown; parent_tool_use_id?: string | null },
    model?: string
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.MESSAGE_TOOL_RESULT,
      sessionId,
      agentType,
      message,
      ...(model ? { model } : {}),
    });
  }

  emitMessageResult(
    sessionId: string,
    agentType: AgentType,
    subtype: string,
    usage?: unknown
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.MESSAGE_RESULT,
      sessionId,
      agentType,
      subtype,
      ...(usage !== undefined ? { usage } : {}),
    });
  }

  emitMessageCancelled(sessionId: string, agentType: AgentType): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.MESSAGE_CANCELLED,
      sessionId,
      agentType,
    });
  }

  // --- Interaction requests ---

  emitRequestOpened(
    requestId: string,
    sessionId: string,
    agentType: AgentType,
    requestType: InteractionRequestType,
    data: unknown
  ): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.REQUEST_OPENED,
      requestId,
      sessionId,
      agentType,
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

  emitAgentSessionId(sessionId: string, agentSessionId: string): void {
    this.emitEvent({
      type: AGENT_EVENT_NAMES.AGENT_SESSION_ID,
      sessionId,
      agentSessionId,
    });
  }

  // ==========================================================================
  // OUTGOING REQUESTS (sidecar -> frontend, with timeout)
  // All request methods delegate to rpc() — a typed wrapper over
  // requireTunnel().request() + withTimeout().
  // ==========================================================================

  // --- Core workspace RPCs ---
  requestExitPlanMode(r: ExitPlanModeRequest) {
    return this.rpc<ExitPlanModeResponse>(
      FRONTEND_RPC_METHODS.EXIT_PLAN_MODE,
      r,
      USER_FACING_TIMEOUT_MS
    );
  }
  requestAskUserQuestion(r: AskUserQuestionRequest) {
    return this.rpc<AskUserQuestionResponse>(
      FRONTEND_RPC_METHODS.ASK_USER_QUESTION,
      r,
      USER_FACING_TIMEOUT_MS
    );
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

  // --- Browser automation RPCs ---
  requestBrowserSnapshot(r: BrowserSnapshotRequest) {
    return this.rpc<BrowserSnapshotResponse>(
      FRONTEND_RPC_METHODS.BROWSER_SNAPSHOT,
      r,
      BROWSER_SNAPSHOT_TIMEOUT_MS
    );
  }
  requestBrowserClick(r: BrowserClickRequest) {
    return this.rpc<BrowserClickResponse>(
      FRONTEND_RPC_METHODS.BROWSER_CLICK,
      r,
      BROWSER_INTERACTION_TIMEOUT_MS
    );
  }
  requestBrowserType(r: BrowserTypeRequest) {
    return this.rpc<BrowserTypeResponse>(
      FRONTEND_RPC_METHODS.BROWSER_TYPE,
      r,
      BROWSER_INTERACTION_TIMEOUT_MS
    );
  }
  requestBrowserNavigate(r: BrowserNavigateRequest) {
    return this.rpc<BrowserNavigateResponse>(
      FRONTEND_RPC_METHODS.BROWSER_NAVIGATE,
      r,
      BROWSER_NAVIGATE_TIMEOUT_MS
    );
  }
  requestBrowserGetState(r: BrowserGetStateRequest) {
    return this.rpc<BrowserGetStateResponse>(
      FRONTEND_RPC_METHODS.BROWSER_GET_STATE,
      r,
      DATA_QUERY_TIMEOUT_MS
    );
  }
  requestBrowserWaitFor(r: BrowserWaitForRequest) {
    return this.rpc<BrowserWaitForResponse>(
      FRONTEND_RPC_METHODS.BROWSER_WAIT_FOR,
      r,
      BROWSER_WAIT_FOR_TIMEOUT_MS
    );
  }
  requestBrowserEvaluate(r: BrowserEvaluateRequest) {
    return this.rpc<BrowserEvaluateResponse>(
      FRONTEND_RPC_METHODS.BROWSER_EVALUATE,
      r,
      BROWSER_EVALUATE_TIMEOUT_MS
    );
  }
  requestBrowserPressKey(r: BrowserPressKeyRequest) {
    return this.rpc<BrowserPressKeyResponse>(
      FRONTEND_RPC_METHODS.BROWSER_PRESS_KEY,
      r,
      BROWSER_INTERACTION_TIMEOUT_MS
    );
  }
  requestBrowserHover(r: BrowserHoverRequest) {
    return this.rpc<BrowserHoverResponse>(
      FRONTEND_RPC_METHODS.BROWSER_HOVER,
      r,
      BROWSER_INTERACTION_TIMEOUT_MS
    );
  }
  requestBrowserSelectOption(r: BrowserSelectOptionRequest) {
    return this.rpc<BrowserSelectOptionResponse>(
      FRONTEND_RPC_METHODS.BROWSER_SELECT_OPTION,
      r,
      BROWSER_INTERACTION_TIMEOUT_MS
    );
  }
  requestBrowserNavigateBack(r: BrowserNavigateBackRequest) {
    return this.rpc<BrowserNavigateBackResponse>(
      FRONTEND_RPC_METHODS.BROWSER_NAVIGATE_BACK,
      r,
      BROWSER_NAVIGATE_BACK_TIMEOUT_MS
    );
  }
  requestBrowserConsoleMessages(r: BrowserConsoleMessagesRequest) {
    return this.rpc<BrowserConsoleMessagesResponse>(
      FRONTEND_RPC_METHODS.BROWSER_CONSOLE_MESSAGES,
      r,
      BROWSER_INTERACTION_TIMEOUT_MS
    );
  }
  requestBrowserNetworkRequests(r: BrowserNetworkRequestsRequest) {
    return this.rpc<BrowserNetworkRequestsResponse>(
      FRONTEND_RPC_METHODS.BROWSER_NETWORK_REQUESTS,
      r,
      BROWSER_INTERACTION_TIMEOUT_MS
    );
  }
  requestBrowserScreenshot(r: BrowserScreenshotRequest) {
    return this.rpc<BrowserScreenshotResponse>(
      FRONTEND_RPC_METHODS.BROWSER_SCREENSHOT,
      r,
      BROWSER_SCREENSHOT_TIMEOUT_MS
    );
  }
  requestBrowserScroll(r: BrowserScrollRequest) {
    return this.rpc<BrowserScrollResponse>(
      FRONTEND_RPC_METHODS.BROWSER_SCROLL,
      r,
      BROWSER_INTERACTION_TIMEOUT_MS
    );
  }

  // --- Simulator automation RPCs ---
  requestSimScreenshot(r: SimScreenshotRequest) {
    return this.rpc<SimScreenshotResponse>(
      FRONTEND_RPC_METHODS.SIM_SCREENSHOT,
      r,
      SIMULATOR_SCREENSHOT_TIMEOUT_MS
    );
  }
  requestSimTap(r: SimTapRequest) {
    return this.rpc<SimTapResponse>(
      FRONTEND_RPC_METHODS.SIM_TAP,
      r,
      SIMULATOR_INTERACTION_TIMEOUT_MS
    );
  }
  requestSimSwipe(r: SimSwipeRequest) {
    return this.rpc<SimSwipeResponse>(
      FRONTEND_RPC_METHODS.SIM_SWIPE,
      r,
      SIMULATOR_INTERACTION_TIMEOUT_MS
    );
  }
  requestSimTypeText(r: SimTypeTextRequest) {
    return this.rpc<SimTypeTextResponse>(
      FRONTEND_RPC_METHODS.SIM_TYPE_TEXT,
      r,
      SIMULATOR_INTERACTION_TIMEOUT_MS
    );
  }
  requestSimPressKey(r: SimPressKeyRequest) {
    return this.rpc<SimPressKeyResponse>(
      FRONTEND_RPC_METHODS.SIM_PRESS_KEY,
      r,
      SIMULATOR_INTERACTION_TIMEOUT_MS
    );
  }
  requestSimBuildAndRun(r: SimBuildAndRunRequest) {
    return this.rpc<SimBuildAndRunResponse>(
      FRONTEND_RPC_METHODS.SIM_BUILD_AND_RUN,
      r,
      SIMULATOR_BUILD_TIMEOUT_MS
    );
  }
  requestSimListDevices(r: SimListDevicesRequest) {
    return this.rpc<SimListDevicesResponse>(
      FRONTEND_RPC_METHODS.SIM_LIST_DEVICES,
      r,
      DATA_QUERY_TIMEOUT_MS
    );
  }
  requestSimStart(r: SimStartRequest) {
    return this.rpc<SimStartResponse>(FRONTEND_RPC_METHODS.SIM_START, r, SIMULATOR_BOOT_TIMEOUT_MS);
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

/** Singleton instance shared across the entire sidecar process */
export const EventBroadcaster = new EventBroadcasterClass();
