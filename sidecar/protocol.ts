// sidecar/protocol.ts
// Zod-validated protocol definitions for JSON-RPC 2.0 communication
// between the OpenDevs frontend/backend and the sidecar agent runtime.

import { z } from "zod";

// ============================================================================
// RPC Method & Notification Constants
// ============================================================================

/** Methods the frontend can call on the sidecar (request/response) */
export const SIDECAR_METHODS = {
  QUERY: "query",
  CANCEL: "cancel",
  CLAUDE_AUTH: "claudeAuth",
  WORKSPACE_INIT: "workspaceInit",
  CONTEXT_USAGE: "contextUsage",
} as const;

/** Notifications the frontend sends to the sidecar (fire-and-forget) */
export const SIDECAR_NOTIFICATIONS = {
  UPDATE_PERMISSION_MODE: "updatePermissionMode",
  RESET_GENERATOR: "resetGenerator",
} as const;

/** Notifications the sidecar sends to the frontend */
export const FRONTEND_NOTIFICATIONS = {
  MESSAGE: "message",
  QUERY_ERROR: "queryError",
  ENTER_PLAN_MODE: "enterPlanModeNotification",
} as const;

/** RPC methods the sidecar can call on the frontend (request/response) */
export const FRONTEND_RPC_METHODS = {
  EXIT_PLAN_MODE: "exitPlanMode",
  ASK_USER_QUESTION: "askUserQuestion",
  GET_DIFF: "getDiff",
  DIFF_COMMENT: "diffComment",
  GET_TERMINAL_OUTPUT: "getTerminalOutput",
  // Browser automation — sidecar asks frontend to eval JS in the webview
  BROWSER_SNAPSHOT: "browserSnapshot",
  BROWSER_CLICK: "browserClick",
  BROWSER_TYPE: "browserType",
  BROWSER_NAVIGATE: "browserNavigate",
  BROWSER_GET_STATE: "browserGetState",
  BROWSER_WAIT_FOR: "browserWaitFor",
  BROWSER_EVALUATE: "browserEvaluate",
  BROWSER_PRESS_KEY: "browserPressKey",
  BROWSER_HOVER: "browserHover",
  BROWSER_SELECT_OPTION: "browserSelectOption",
  BROWSER_NAVIGATE_BACK: "browserNavigateBack",
  BROWSER_CONSOLE_MESSAGES: "browserConsoleMessages",
  BROWSER_NETWORK_REQUESTS: "browserNetworkRequests",
  BROWSER_SCREENSHOT: "browserScreenshot",
  BROWSER_SCROLL: "browserScroll",
  // Simulator automation — sidecar asks frontend to interact with the iOS simulator
  SIM_SCREENSHOT: "simScreenshot",
  SIM_TAP: "simTap",
  SIM_SWIPE: "simSwipe",
  SIM_TYPE_TEXT: "simTypeText",
  SIM_PRESS_KEY: "simPressKey",
  SIM_BUILD_AND_RUN: "simBuildAndRun",
  SIM_LIST_DEVICES: "simListDevices",
  SIM_START: "simStart",
} as const;

// ============================================================================
// Zod Schemas
// ============================================================================

export const AgentTypeSchema = z.enum(["claude", "codex", "unknown"]);

/** Error categories for structured error responses (inspired by Codex CodexErrorInfo) */
export const ErrorCategorySchema = z.enum([
  "auth",
  "rate_limit",
  "context_limit",
  "network",
  "abort",
  "invalid_request",
  "db_write",
  "internal",
]);

/** Synchronous ACK/reject response for query method */
export const QueryAckResponseSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
});

export const QueryRequestSchema = z.object({
  type: z.literal("query"),
  id: z.string(),
  agentType: AgentTypeSchema,
  prompt: z.string(),
  options: z.object({
    cwd: z.string(),
    model: z.string().optional(),
    maxThinkingTokens: z.number().optional(),
    maxTurns: z.number().optional(),
    turnId: z.string().optional(),
    permissionMode: z.string().optional(),
    claudeEnvVars: z.string().optional(),
    ghToken: z.string().optional(),
    opendevsEnv: z.record(z.string(), z.string()).optional(),
    additionalDirectories: z.array(z.string()).optional(),
    chromeEnabled: z.boolean().optional(),
    strictDataPrivacy: z.boolean().optional(),
    shouldResetGenerator: z.boolean().optional(),
    resume: z.string().optional(),
    resumeSessionAt: z.string().optional(),
  }),
});

export const CancelRequestSchema = z.object({
  type: z.literal("cancel"),
  id: z.string(),
  agentType: AgentTypeSchema,
});

export const ClaudeAuthRequestSchema = z.object({
  type: z.literal("claude_auth"),
  id: z.string(),
  agentType: AgentTypeSchema,
  options: z.object({
    cwd: z.string(),
  }),
});

export const WorkspaceInitRequestSchema = z.object({
  type: z.literal("workspace_init"),
  id: z.string(),
  agentType: AgentTypeSchema,
  options: z.object({
    cwd: z.string(),
    ghToken: z.string().optional(),
    claudeEnvVars: z.string().optional(),
  }),
});

export const ContextUsageRequestSchema = z.object({
  type: z.literal("context_usage"),
  id: z.string(),
  agentType: AgentTypeSchema,
  options: z.object({
    cwd: z.string(),
    claudeSessionId: z.string(),
  }),
});

export const UpdatePermissionModeRequestSchema = z.object({
  type: z.literal("update_permission_mode"),
  id: z.string(),
  agentType: AgentTypeSchema,
  permissionMode: z.string(),
});

export const ResetGeneratorRequestSchema = z.object({
  type: z.literal("reset_generator"),
  id: z.string(),
  agentType: AgentTypeSchema,
});

export const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  agentType: AgentTypeSchema,
  data: z.unknown(),
});

export const ErrorResponseSchema = z.object({
  id: z.string(),
  type: z.literal("error"),
  error: z.string(),
  agentType: AgentTypeSchema,
  category: ErrorCategorySchema.optional(),
});

export const EnterPlanModeNotificationSchema = z.object({
  type: z.literal("enter_plan_mode_notification"),
  id: z.string(),
  agentType: AgentTypeSchema,
});

// ============================================================================
// Browser Automation Schemas (sidecar → frontend requests)
// ============================================================================

export const BrowserSnapshotRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserSnapshotResponseSchema = z.object({
  snapshot: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserClickRequestSchema = z.object({
  sessionId: z.string(),
  ref: z.string().describe("Element data-cursor-ref to click"),
  doubleClick: z.boolean().optional(),
  webviewLabel: z.string().optional(),
});

export const BrowserClickResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserTypeRequestSchema = z.object({
  sessionId: z.string(),
  ref: z.string().describe("Element data-cursor-ref to type into"),
  text: z.string(),
  submit: z.boolean().optional(),
  slowly: z.boolean().optional(),
  webviewLabel: z.string().optional(),
});

export const BrowserTypeResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserNavigateRequestSchema = z.object({
  sessionId: z.string(),
  url: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserNavigateResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  webviewLabel: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserGetStateRequestSchema = z.object({
  sessionId: z.string(),
});

export const BrowserGetStateResponseSchema = z.object({
  available: z.boolean(),
  activeTab: z
    .object({
      webviewLabel: z.string(),
      url: z.string(),
      title: z.string(),
    })
    .optional(),
  hint: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserWaitForRequestSchema = z.object({
  sessionId: z.string(),
  text: z.string().optional().describe("Wait until this text appears on the page"),
  textGone: z.string().optional().describe("Wait until this text disappears from the page"),
  time: z.number().optional().describe("Wait for a fixed number of seconds"),
  timeout: z.number().optional().describe("Maximum wait time in seconds (default: 30)"),
  webviewLabel: z.string().optional(),
});

export const BrowserWaitForResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserEvaluateRequestSchema = z.object({
  sessionId: z.string(),
  code: z.string().describe("JavaScript code to evaluate in the page context"),
  ref: z
    .string()
    .optional()
    .describe("Element ref — if provided, the element is passed as 'element' argument"),
  webviewLabel: z.string().optional(),
});

export const BrowserEvaluateResponseSchema = z.object({
  result: z.string().optional(),
  snapshot: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserPressKeyRequestSchema = z.object({
  sessionId: z.string(),
  key: z.string().describe("Key name (Enter, Tab, Escape, ArrowDown, etc.) or single character"),
  ctrl: z.boolean().optional().describe("Hold Ctrl/Control key"),
  shift: z.boolean().optional().describe("Hold Shift key"),
  alt: z.boolean().optional().describe("Hold Alt/Option key"),
  meta: z.boolean().optional().describe("Hold Meta/Cmd key"),
  webviewLabel: z.string().optional(),
});

export const BrowserPressKeyResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const BrowserHoverRequestSchema = z.object({
  sessionId: z.string(),
  ref: z.string().describe("Element data-cursor-ref to hover over"),
  webviewLabel: z.string().optional(),
});

export const BrowserHoverResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserSelectOptionRequestSchema = z.object({
  sessionId: z.string(),
  ref: z.string().describe("The <select> element's data-cursor-ref"),
  values: z.array(z.string()).describe("Option values or text labels to select"),
  webviewLabel: z.string().optional(),
});

export const BrowserSelectOptionResponseSchema = z.object({
  success: z.boolean(),
  matched: z.number().optional(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserNavigateBackRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserNavigateBackResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserConsoleMessagesRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserConsoleMessagesResponseSchema = z.object({
  logs: z.string(),
  count: z.number(),
  error: z.string().optional(),
});

export const BrowserNetworkRequestsRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserNetworkRequestsResponseSchema = z.object({
  requests: z.string(),
  count: z.number(),
  error: z.string().optional(),
});

export const BrowserScrollRequestSchema = z.object({
  sessionId: z.string(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().optional(),
  ref: z.string().optional(),
  webviewLabel: z.string().optional(),
});

export const BrowserScrollResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserScreenshotRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
  /** Optional crop region in CSS points. When set, only this area is captured. */
  rect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

export const BrowserScreenshotResponseSchema = z.object({
  image: z.string().describe("Base64-encoded JPEG screenshot"),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

// ============================================================================
// Simulator Automation Schemas (sidecar → frontend requests)
// ============================================================================

export const SimScreenshotRequestSchema = z.object({
  sessionId: z.string(),
});

export const SimScreenshotResponseSchema = z.object({
  image: z.string().describe("Base64-encoded JPEG screenshot"),
  error: z.string().optional(),
});

const NormalizedCoord = z.number().min(0).max(1);

export const SimTapRequestSchema = z.object({
  sessionId: z.string(),
  x: NormalizedCoord.describe("Normalized X coordinate (0.0–1.0)"),
  y: NormalizedCoord.describe("Normalized Y coordinate (0.0–1.0)"),
});

export const SimTapResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const SimSwipeRequestSchema = z.object({
  sessionId: z.string(),
  startX: NormalizedCoord.describe("Normalized start X (0.0–1.0)"),
  startY: NormalizedCoord.describe("Normalized start Y (0.0–1.0)"),
  endX: NormalizedCoord.describe("Normalized end X (0.0–1.0)"),
  endY: NormalizedCoord.describe("Normalized end Y (0.0–1.0)"),
  durationMs: z.number().int().positive().max(30_000).optional().describe("Swipe duration in ms (default: 300)"),
});

export const SimSwipeResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const SimTypeTextRequestSchema = z.object({
  sessionId: z.string(),
  text: z.string().describe("Text to type"),
});

export const SimTypeTextResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const SimPressKeyRequestSchema = z.object({
  sessionId: z.string(),
  keycode: z.number().int().min(0).max(0xffff).describe("USB HID usage code"),
  direction: z.enum(["down", "up"]).optional().describe("Key direction (default: down+up)"),
});

export const SimPressKeyResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const SimBuildAndRunRequestSchema = z.object({
  sessionId: z.string(),
  workspacePath: z.string().describe("Path to the workspace containing the Xcode project"),
});

export const SimBuildAndRunResponseSchema = z.object({
  success: z.boolean(),
  bundleId: z.string().optional(),
  appName: z.string().optional(),
  error: z.string().optional(),
});

export const SimListDevicesRequestSchema = z.object({
  sessionId: z.string(),
});

export const SimListDevicesResponseSchema = z.object({
  devices: z.array(
    z.object({
      name: z.string(),
      udid: z.string(),
      state: z.string().describe("Booted | Shutdown"),
      runtime: z.string(),
      deviceType: z.string(),
      isAvailable: z.boolean(),
    })
  ),
  error: z.string().optional(),
});

export const SimStartRequestSchema = z.object({
  sessionId: z.string(),
  udid: z.string().describe("UDID of the simulator to boot and start streaming"),
});

export const SimStartResponseSchema = z.object({
  success: z.boolean(),
  url: z.string().optional().describe("MJPEG stream URL"),
  port: z.number().optional(),
  hidAvailable: z.boolean().optional().describe("Whether HID touch/key injection is available"),
  error: z.string().optional(),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type AgentType = z.infer<typeof AgentTypeSchema>;
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type QueryAckResponse = z.infer<typeof QueryAckResponseSchema>;
export type QueryRequest = z.infer<typeof QueryRequestSchema>;
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
export type ClaudeAuthRequest = z.infer<typeof ClaudeAuthRequestSchema>;
export type WorkspaceInitRequest = z.infer<typeof WorkspaceInitRequestSchema>;
export type ContextUsageRequest = z.infer<typeof ContextUsageRequestSchema>;
export type UpdatePermissionModeRequest = z.infer<typeof UpdatePermissionModeRequestSchema>;
export type ResetGeneratorRequest = z.infer<typeof ResetGeneratorRequestSchema>;
export type MessageResponse = z.infer<typeof MessageResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type EnterPlanModeNotification = z.infer<typeof EnterPlanModeNotificationSchema>;
export type BrowserSnapshotRequest = z.infer<typeof BrowserSnapshotRequestSchema>;
export type BrowserSnapshotResponse = z.infer<typeof BrowserSnapshotResponseSchema>;
export type BrowserClickRequest = z.infer<typeof BrowserClickRequestSchema>;
export type BrowserClickResponse = z.infer<typeof BrowserClickResponseSchema>;
export type BrowserTypeRequest = z.infer<typeof BrowserTypeRequestSchema>;
export type BrowserTypeResponse = z.infer<typeof BrowserTypeResponseSchema>;
export type BrowserNavigateRequest = z.infer<typeof BrowserNavigateRequestSchema>;
export type BrowserNavigateResponse = z.infer<typeof BrowserNavigateResponseSchema>;
export type BrowserGetStateRequest = z.infer<typeof BrowserGetStateRequestSchema>;
export type BrowserGetStateResponse = z.infer<typeof BrowserGetStateResponseSchema>;
export type BrowserWaitForRequest = z.infer<typeof BrowserWaitForRequestSchema>;
export type BrowserWaitForResponse = z.infer<typeof BrowserWaitForResponseSchema>;
export type BrowserEvaluateRequest = z.infer<typeof BrowserEvaluateRequestSchema>;
export type BrowserEvaluateResponse = z.infer<typeof BrowserEvaluateResponseSchema>;
export type BrowserPressKeyRequest = z.infer<typeof BrowserPressKeyRequestSchema>;
export type BrowserPressKeyResponse = z.infer<typeof BrowserPressKeyResponseSchema>;
export type BrowserHoverRequest = z.infer<typeof BrowserHoverRequestSchema>;
export type BrowserHoverResponse = z.infer<typeof BrowserHoverResponseSchema>;
export type BrowserSelectOptionRequest = z.infer<typeof BrowserSelectOptionRequestSchema>;
export type BrowserSelectOptionResponse = z.infer<typeof BrowserSelectOptionResponseSchema>;
export type BrowserNavigateBackRequest = z.infer<typeof BrowserNavigateBackRequestSchema>;
export type BrowserNavigateBackResponse = z.infer<typeof BrowserNavigateBackResponseSchema>;
export type BrowserConsoleMessagesRequest = z.infer<typeof BrowserConsoleMessagesRequestSchema>;
export type BrowserConsoleMessagesResponse = z.infer<typeof BrowserConsoleMessagesResponseSchema>;
export type BrowserNetworkRequestsRequest = z.infer<typeof BrowserNetworkRequestsRequestSchema>;
export type BrowserNetworkRequestsResponse = z.infer<typeof BrowserNetworkRequestsResponseSchema>;
export type BrowserScrollRequest = z.infer<typeof BrowserScrollRequestSchema>;
export type BrowserScrollResponse = z.infer<typeof BrowserScrollResponseSchema>;
export type BrowserScreenshotRequest = z.infer<typeof BrowserScreenshotRequestSchema>;
export type BrowserScreenshotResponse = z.infer<typeof BrowserScreenshotResponseSchema>;
export type SimScreenshotRequest = z.infer<typeof SimScreenshotRequestSchema>;
export type SimScreenshotResponse = z.infer<typeof SimScreenshotResponseSchema>;
export type SimTapRequest = z.infer<typeof SimTapRequestSchema>;
export type SimTapResponse = z.infer<typeof SimTapResponseSchema>;
export type SimSwipeRequest = z.infer<typeof SimSwipeRequestSchema>;
export type SimSwipeResponse = z.infer<typeof SimSwipeResponseSchema>;
export type SimTypeTextRequest = z.infer<typeof SimTypeTextRequestSchema>;
export type SimTypeTextResponse = z.infer<typeof SimTypeTextResponseSchema>;
export type SimPressKeyRequest = z.infer<typeof SimPressKeyRequestSchema>;
export type SimPressKeyResponse = z.infer<typeof SimPressKeyResponseSchema>;
export type SimBuildAndRunRequest = z.infer<typeof SimBuildAndRunRequestSchema>;
export type SimBuildAndRunResponse = z.infer<typeof SimBuildAndRunResponseSchema>;
export type SimListDevicesRequest = z.infer<typeof SimListDevicesRequestSchema>;
export type SimListDevicesResponse = z.infer<typeof SimListDevicesResponseSchema>;
export type SimStartRequest = z.infer<typeof SimStartRequestSchema>;
export type SimStartResponse = z.infer<typeof SimStartResponseSchema>;

// ============================================================================
// Type Guard Functions
// ============================================================================

export function isQueryRequest(value: unknown): value is QueryRequest {
  return QueryRequestSchema.safeParse(value).success;
}

export function isCancelRequest(value: unknown): value is CancelRequest {
  return CancelRequestSchema.safeParse(value).success;
}

export function isClaudeAuthRequest(value: unknown): value is ClaudeAuthRequest {
  return ClaudeAuthRequestSchema.safeParse(value).success;
}

export function isWorkspaceInitRequest(value: unknown): value is WorkspaceInitRequest {
  return WorkspaceInitRequestSchema.safeParse(value).success;
}

export function isContextUsageRequest(value: unknown): value is ContextUsageRequest {
  return ContextUsageRequestSchema.safeParse(value).success;
}

export function isUpdatePermissionModeRequest(
  value: unknown
): value is UpdatePermissionModeRequest {
  return UpdatePermissionModeRequestSchema.safeParse(value).success;
}

export function isResetGeneratorRequest(value: unknown): value is ResetGeneratorRequest {
  return ResetGeneratorRequestSchema.safeParse(value).success;
}
