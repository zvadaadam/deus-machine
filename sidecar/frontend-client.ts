// sidecar/frontend-client.ts
// Singleton facade over the RPC connection that exposes typed methods
// for every message the sidecar exchanges with the OpenDevs frontend.

import type { RpcConnection } from "./rpc-connection";
import {
  FRONTEND_NOTIFICATIONS,
  FRONTEND_RPC_METHODS,
  SIDECAR_METHODS,
  SIDECAR_NOTIFICATIONS,
  isQueryRequest,
  isCancelRequest,
  isClaudeAuthRequest,
  isWorkspaceInitRequest,
  isContextUsageRequest,
  isUpdatePermissionModeRequest,
  isResetGeneratorRequest,
} from "./protocol";
import type {
  QueryRequest,
  QueryAckResponse,
  CancelRequest,
  ClaudeAuthRequest,
  WorkspaceInitRequest,
  ContextUsageRequest,
  UpdatePermissionModeRequest,
  ResetGeneratorRequest,
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
// FrontendClient class
// ============================================================================

class FrontendClientClass {
  // Multi-tunnel: all connected clients receive notifications.
  // The gateway and desktop app can be connected simultaneously.
  private tunnels = new Set<RpcConnection>();

  attachTunnel(tunnel: RpcConnection): void {
    this.tunnels.add(tunnel);
    console.log(`[FrontendClient] Tunnel attached (${this.tunnels.size} active)`);
  }

  /**
   * Detach a specific tunnel. If tunnel is provided, removes only that one.
   * If no tunnel is provided, clears all tunnels.
   */
  detachTunnel(tunnel?: RpcConnection): void {
    if (tunnel) {
      this.tunnels.delete(tunnel);
      console.log(`[FrontendClient] Tunnel detached (${this.tunnels.size} remaining)`);
    } else {
      this.tunnels.clear();
      console.log("[FrontendClient] All tunnels cleared");
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
  // OUTGOING REQUESTS (sidecar -> frontend, with timeout)
  // ==========================================================================

  async requestExitPlanMode(request: ExitPlanModeRequest): Promise<ExitPlanModeResponse> {
    return this.withTimeout<ExitPlanModeResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.EXIT_PLAN_MODE,
        request
      ) as Promise<ExitPlanModeResponse>,
      USER_FACING_TIMEOUT_MS,
      "requestExitPlanMode"
    );
  }

  async requestAskUserQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionResponse> {
    return this.withTimeout<AskUserQuestionResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.ASK_USER_QUESTION,
        request
      ) as Promise<AskUserQuestionResponse>,
      USER_FACING_TIMEOUT_MS,
      "requestAskUserQuestion"
    );
  }

  async requestGetDiff(request: GetDiffRequest): Promise<GetDiffResponse> {
    return this.withTimeout<GetDiffResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.GET_DIFF,
        request
      ) as Promise<GetDiffResponse>,
      DATA_QUERY_TIMEOUT_MS,
      "requestGetDiff"
    );
  }

  async requestDiffComment(request: DiffCommentRequest): Promise<DiffCommentResponse> {
    return this.withTimeout<DiffCommentResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.DIFF_COMMENT,
        request
      ) as Promise<DiffCommentResponse>,
      DATA_QUERY_TIMEOUT_MS,
      "requestDiffComment"
    );
  }

  async requestGetTerminalOutput(
    request: GetTerminalOutputRequest
  ): Promise<GetTerminalOutputResponse> {
    return this.withTimeout<GetTerminalOutputResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.GET_TERMINAL_OUTPUT,
        request
      ) as Promise<GetTerminalOutputResponse>,
      DATA_QUERY_TIMEOUT_MS,
      "requestGetTerminalOutput"
    );
  }

  // ==========================================================================
  // BROWSER AUTOMATION REQUESTS (sidecar -> frontend, with timeout)
  // ==========================================================================

  async requestBrowserSnapshot(request: BrowserSnapshotRequest): Promise<BrowserSnapshotResponse> {
    return this.withTimeout<BrowserSnapshotResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_SNAPSHOT,
        request
      ) as Promise<BrowserSnapshotResponse>,
      BROWSER_SNAPSHOT_TIMEOUT_MS,
      "requestBrowserSnapshot"
    );
  }

  async requestBrowserClick(request: BrowserClickRequest): Promise<BrowserClickResponse> {
    return this.withTimeout<BrowserClickResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_CLICK,
        request
      ) as Promise<BrowserClickResponse>,
      BROWSER_INTERACTION_TIMEOUT_MS,
      "requestBrowserClick"
    );
  }

  async requestBrowserType(request: BrowserTypeRequest): Promise<BrowserTypeResponse> {
    return this.withTimeout<BrowserTypeResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_TYPE,
        request
      ) as Promise<BrowserTypeResponse>,
      BROWSER_INTERACTION_TIMEOUT_MS,
      "requestBrowserType"
    );
  }

  async requestBrowserNavigate(request: BrowserNavigateRequest): Promise<BrowserNavigateResponse> {
    return this.withTimeout<BrowserNavigateResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_NAVIGATE,
        request
      ) as Promise<BrowserNavigateResponse>,
      BROWSER_NAVIGATE_TIMEOUT_MS,
      "requestBrowserNavigate"
    );
  }

  async requestBrowserGetState(request: BrowserGetStateRequest): Promise<BrowserGetStateResponse> {
    return this.withTimeout<BrowserGetStateResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_GET_STATE,
        request
      ) as Promise<BrowserGetStateResponse>,
      DATA_QUERY_TIMEOUT_MS,
      "requestBrowserGetState"
    );
  }

  async requestBrowserWaitFor(request: BrowserWaitForRequest): Promise<BrowserWaitForResponse> {
    return this.withTimeout<BrowserWaitForResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_WAIT_FOR,
        request
      ) as Promise<BrowserWaitForResponse>,
      BROWSER_WAIT_FOR_TIMEOUT_MS,
      "requestBrowserWaitFor"
    );
  }

  async requestBrowserEvaluate(request: BrowserEvaluateRequest): Promise<BrowserEvaluateResponse> {
    return this.withTimeout<BrowserEvaluateResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_EVALUATE,
        request
      ) as Promise<BrowserEvaluateResponse>,
      BROWSER_EVALUATE_TIMEOUT_MS,
      "requestBrowserEvaluate"
    );
  }

  async requestBrowserPressKey(request: BrowserPressKeyRequest): Promise<BrowserPressKeyResponse> {
    return this.withTimeout<BrowserPressKeyResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_PRESS_KEY,
        request
      ) as Promise<BrowserPressKeyResponse>,
      BROWSER_INTERACTION_TIMEOUT_MS,
      "requestBrowserPressKey"
    );
  }

  async requestBrowserHover(request: BrowserHoverRequest): Promise<BrowserHoverResponse> {
    return this.withTimeout<BrowserHoverResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_HOVER,
        request
      ) as Promise<BrowserHoverResponse>,
      BROWSER_INTERACTION_TIMEOUT_MS,
      "requestBrowserHover"
    );
  }

  async requestBrowserSelectOption(
    request: BrowserSelectOptionRequest
  ): Promise<BrowserSelectOptionResponse> {
    return this.withTimeout<BrowserSelectOptionResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_SELECT_OPTION,
        request
      ) as Promise<BrowserSelectOptionResponse>,
      BROWSER_INTERACTION_TIMEOUT_MS,
      "requestBrowserSelectOption"
    );
  }

  async requestBrowserNavigateBack(
    request: BrowserNavigateBackRequest
  ): Promise<BrowserNavigateBackResponse> {
    return this.withTimeout<BrowserNavigateBackResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_NAVIGATE_BACK,
        request
      ) as Promise<BrowserNavigateBackResponse>,
      BROWSER_NAVIGATE_BACK_TIMEOUT_MS,
      "requestBrowserNavigateBack"
    );
  }

  async requestBrowserConsoleMessages(
    request: BrowserConsoleMessagesRequest
  ): Promise<BrowserConsoleMessagesResponse> {
    return this.withTimeout<BrowserConsoleMessagesResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_CONSOLE_MESSAGES,
        request
      ) as Promise<BrowserConsoleMessagesResponse>,
      BROWSER_INTERACTION_TIMEOUT_MS,
      "requestBrowserConsoleMessages"
    );
  }

  async requestBrowserNetworkRequests(
    request: BrowserNetworkRequestsRequest
  ): Promise<BrowserNetworkRequestsResponse> {
    return this.withTimeout<BrowserNetworkRequestsResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_NETWORK_REQUESTS,
        request
      ) as Promise<BrowserNetworkRequestsResponse>,
      BROWSER_INTERACTION_TIMEOUT_MS,
      "requestBrowserNetworkRequests"
    );
  }

  async requestBrowserScreenshot(
    request: BrowserScreenshotRequest
  ): Promise<BrowserScreenshotResponse> {
    return this.withTimeout<BrowserScreenshotResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_SCREENSHOT,
        request
      ) as Promise<BrowserScreenshotResponse>,
      BROWSER_SCREENSHOT_TIMEOUT_MS,
      "requestBrowserScreenshot"
    );
  }

  async requestBrowserScroll(request: BrowserScrollRequest): Promise<BrowserScrollResponse> {
    return this.withTimeout<BrowserScrollResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.BROWSER_SCROLL,
        request
      ) as Promise<BrowserScrollResponse>,
      BROWSER_INTERACTION_TIMEOUT_MS,
      "requestBrowserScroll"
    );
  }

  // ==========================================================================
  // SIMULATOR AUTOMATION REQUESTS (sidecar -> frontend, with timeout)
  // ==========================================================================

  async requestSimScreenshot(request: SimScreenshotRequest): Promise<SimScreenshotResponse> {
    return this.withTimeout<SimScreenshotResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.SIM_SCREENSHOT,
        request
      ) as Promise<SimScreenshotResponse>,
      SIMULATOR_SCREENSHOT_TIMEOUT_MS,
      "requestSimScreenshot"
    );
  }

  async requestSimTap(request: SimTapRequest): Promise<SimTapResponse> {
    return this.withTimeout<SimTapResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.SIM_TAP,
        request
      ) as Promise<SimTapResponse>,
      SIMULATOR_INTERACTION_TIMEOUT_MS,
      "requestSimTap"
    );
  }

  async requestSimSwipe(request: SimSwipeRequest): Promise<SimSwipeResponse> {
    return this.withTimeout<SimSwipeResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.SIM_SWIPE,
        request
      ) as Promise<SimSwipeResponse>,
      SIMULATOR_INTERACTION_TIMEOUT_MS,
      "requestSimSwipe"
    );
  }

  async requestSimTypeText(request: SimTypeTextRequest): Promise<SimTypeTextResponse> {
    return this.withTimeout<SimTypeTextResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.SIM_TYPE_TEXT,
        request
      ) as Promise<SimTypeTextResponse>,
      SIMULATOR_INTERACTION_TIMEOUT_MS,
      "requestSimTypeText"
    );
  }

  async requestSimPressKey(request: SimPressKeyRequest): Promise<SimPressKeyResponse> {
    return this.withTimeout<SimPressKeyResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.SIM_PRESS_KEY,
        request
      ) as Promise<SimPressKeyResponse>,
      SIMULATOR_INTERACTION_TIMEOUT_MS,
      "requestSimPressKey"
    );
  }

  async requestSimBuildAndRun(request: SimBuildAndRunRequest): Promise<SimBuildAndRunResponse> {
    return this.withTimeout<SimBuildAndRunResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.SIM_BUILD_AND_RUN,
        request
      ) as Promise<SimBuildAndRunResponse>,
      SIMULATOR_BUILD_TIMEOUT_MS,
      "requestSimBuildAndRun"
    );
  }

  async requestSimListDevices(request: SimListDevicesRequest): Promise<SimListDevicesResponse> {
    return this.withTimeout<SimListDevicesResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.SIM_LIST_DEVICES,
        request
      ) as Promise<SimListDevicesResponse>,
      DATA_QUERY_TIMEOUT_MS,
      "requestSimListDevices"
    );
  }

  async requestSimStart(request: SimStartRequest): Promise<SimStartResponse> {
    return this.withTimeout<SimStartResponse>(
      this.requireTunnel().request(
        FRONTEND_RPC_METHODS.SIM_START,
        request
      ) as Promise<SimStartResponse>,
      SIMULATOR_BOOT_TIMEOUT_MS,
      "requestSimStart"
    );
  }

  // ==========================================================================
  // INCOMING EVENTS (frontend -> sidecar)
  // ==========================================================================

  onQuery(handler: (request: Omit<QueryRequest, "type">) => Promise<QueryAckResponse>): void {
    this.requireTunnel().addMethod(SIDECAR_METHODS.QUERY, async (params) => {
      if (!isQueryRequest(params)) return { accepted: false, reason: "Invalid query request" };
      const { type: _, ...input } = params;
      return handler(input);
    });
  }

  onCancel(tunnel: RpcConnection, handler: (request: Omit<CancelRequest, "type">) => void): void {
    tunnel.addMethod(SIDECAR_METHODS.CANCEL, (params) => {
      if (!isCancelRequest(params)) return Promise.resolve(undefined);
      const { type: _, ...input } = params;
      handler(input);
      return Promise.resolve(undefined);
    });
  }

  onClaudeAuth(tunnel: RpcConnection, handler: (request: Omit<ClaudeAuthRequest, "type">) => Promise<any>): void {
    tunnel.addMethod(SIDECAR_METHODS.CLAUDE_AUTH, (params) => {
      if (!isClaudeAuthRequest(params)) {
        return Promise.reject(new Error("Invalid claudeAuth request"));
      }
      const { type: _, ...input } = params;
      return handler(input);
    });
  }

  onWorkspaceInit(tunnel: RpcConnection, handler: (request: Omit<WorkspaceInitRequest, "type">) => Promise<any>): void {
    tunnel.addMethod(SIDECAR_METHODS.WORKSPACE_INIT, (params) => {
      if (!isWorkspaceInitRequest(params)) {
        return Promise.reject(new Error("Invalid workspaceInit request"));
      }
      const { type: _, ...input } = params;
      return handler(input);
    });
  }

  onContextUsage(tunnel: RpcConnection, handler: (request: Omit<ContextUsageRequest, "type">) => Promise<any>): void {
    tunnel.addMethod(SIDECAR_METHODS.CONTEXT_USAGE, (params) => {
      if (!isContextUsageRequest(params)) {
        return Promise.reject(new Error("Invalid contextUsage request"));
      }
      const { type: _, ...input } = params;
      return handler(input);
    });
  }

  onUpdatePermissionMode(
    tunnel: RpcConnection,
    handler: (request: Omit<UpdatePermissionModeRequest, "type">) => void
  ): void {
    tunnel.addMethod(SIDECAR_NOTIFICATIONS.UPDATE_PERMISSION_MODE, (params) => {
      if (!isUpdatePermissionModeRequest(params)) return Promise.resolve(undefined);
      const { type: _, ...input } = params;
      handler(input);
      return Promise.resolve(undefined);
    });
  }

  onResetGenerator(tunnel: RpcConnection, handler: (request: Omit<ResetGeneratorRequest, "type">) => void): void {
    tunnel.addMethod(SIDECAR_NOTIFICATIONS.RESET_GENERATOR, (params) => {
      if (!isResetGeneratorRequest(params)) return Promise.resolve(undefined);
      const { type: _, ...input } = params;
      handler(input);
      return Promise.resolve(undefined);
    });
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  /** Returns the first available tunnel, or throws if none are connected. */
  private requireTunnel(): RpcConnection {
    const first = this.tunnels.values().next().value;
    if (!first) {
      throw new Error("FrontendClient tunnel not attached.");
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
        console.error(`[FrontendClient] ${label} failed, removing dead tunnel:`, err);
        this.tunnels.delete(tunnel);
      }
    }
    const elapsed = Date.now() - t0;
    if (elapsed > 5) {
      console.log(`[TIMING][FrontendClient] ${label} broadcast took ${elapsed}ms (${this.tunnels.size} tunnels)`);
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
          new Error(`[FrontendClient] ${label} timed out after ${ms}ms -- frontend did not respond`)
        );
      }, ms);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timerId !== undefined) clearTimeout(timerId);
    });
  }
}

/** Singleton instance shared across the entire sidecar process */
export const FrontendClient = new FrontendClientClass();
