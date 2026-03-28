// agent-server/rpc-schemas.ts
// Zod schemas and inferred types for MCP-facing RPC communication
// between the agent-server and frontend (browser automation, simulator,
// diff, terminal, plan mode, user questions).
//
// Extracted from protocol.ts for cleaner separation of constants vs schemas.

import { z } from "zod";

// ============================================================================
// MCP-Facing RPC Schemas (agent-server → frontend requests/responses)
// ============================================================================

export const AskUserQuestionRequestSchema = z.object({
  sessionId: z.string(),
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()),
      multiSelect: z.boolean().optional(),
    })
  ),
});

export const AskUserQuestionResponseSchema = z.object({
  answers: z.array(z.union([z.string(), z.array(z.string())])),
});

export const GetDiffRequestSchema = z.object({
  sessionId: z.string(),
  file: z.string().optional(),
  stat: z.boolean().optional(),
});

export const GetDiffResponseSchema = z.object({
  diff: z.string().optional(),
  error: z.string().optional(),
});

export const DiffCommentRequestSchema = z.object({
  sessionId: z.string(),
  comments: z.array(
    z.object({
      file: z.string(),
      lineNumber: z.number(),
      body: z.string(),
    })
  ),
});

export const DiffCommentResponseSchema = z.object({
  success: z.boolean(),
});

export const GetTerminalOutputRequestSchema = z.object({
  sessionId: z.string(),
  source: z.enum(["spotlight", "run_script", "terminal", "auto"]).optional(),
  maxLines: z.number().optional(),
});

export const GetTerminalOutputResponseSchema = z.object({
  output: z.string().optional(),
  source: z.enum(["spotlight", "run_script", "terminal", "none"]),
  isRunning: z.boolean().optional(),
  error: z.string().optional(),
});

export const ExitPlanModeRequestSchema = z.object({
  sessionId: z.string(),
  toolInput: z.unknown(),
});

export const ExitPlanModeResponseSchema = z.object({
  approved: z.boolean(),
  turnId: z.string().optional(),
});

// ============================================================================
// Browser Automation Schemas (agent-server → frontend requests)
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
  ref: z.string().optional().describe("Element data-cursor-ref to click"),
  x: z.number().optional().describe("X coordinate for coordinate-based click"),
  y: z.number().optional().describe("Y coordinate for coordinate-based click"),
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
  image: z.string().describe("Base64-encoded PNG screenshot"),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

// ============================================================================
// Simulator Automation Schemas (agent-server → frontend requests)
// ============================================================================

export const SimScreenshotRequestSchema = z.object({
  sessionId: z.string(),
});

export const SimScreenshotResponseSchema = z.object({
  image: z.string().describe("Base64-encoded PNG screenshot"),
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
  durationMs: z
    .number()
    .int()
    .positive()
    .max(30_000)
    .optional()
    .describe("Swipe duration in ms (default: 300)"),
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
      state: z.enum(["Booted", "Shutdown", "Unknown"]),
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
// Inferred Types (agent-server-local schemas only; RPC types re-exported in protocol.ts)
// ============================================================================

export type AskUserQuestionRequest = z.infer<typeof AskUserQuestionRequestSchema>;
export type AskUserQuestionResponse = z.infer<typeof AskUserQuestionResponseSchema>;
export type GetDiffRequest = z.infer<typeof GetDiffRequestSchema>;
export type GetDiffResponse = z.infer<typeof GetDiffResponseSchema>;
export type DiffCommentRequest = z.infer<typeof DiffCommentRequestSchema>;
export type DiffCommentResponse = z.infer<typeof DiffCommentResponseSchema>;
export type GetTerminalOutputRequest = z.infer<typeof GetTerminalOutputRequestSchema>;
export type GetTerminalOutputResponse = z.infer<typeof GetTerminalOutputResponseSchema>;
export type ExitPlanModeRequest = z.infer<typeof ExitPlanModeRequestSchema>;
export type ExitPlanModeResponse = z.infer<typeof ExitPlanModeResponseSchema>;
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
