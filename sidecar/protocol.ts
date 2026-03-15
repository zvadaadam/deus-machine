// sidecar/protocol.ts
// Protocol definitions for JSON-RPC 2.0 communication between the
// OpenDevs backend and the sidecar agent runtime.
//
// Query/options schemas (QueryRequest, QueryOptions) are canonical in
// shared/protocol.ts. MCP-facing RPC schemas (browser, simulator, diff,
// terminal, plan mode) live in rpc-schemas.ts; re-exported here.

import { AgentTypeSchema, ErrorCategorySchema, SessionStatusSchema } from "../shared/enums";
import {
  EnterPlanModeNotificationSchema,
  ErrorResponseSchema,
  MessageResponseSchema,
  StatusChangedNotificationSchema,
} from "../shared/session-events";

// Canonical schemas — re-exported for existing sidecar imports.
export { QueryOptionsSchema, QueryRequestSchema } from "../shared/protocol";

export type { QueryOptions, QueryRequest } from "../shared/protocol";

// ============================================================================
// RPC Method & Notification Constants (sidecar-only)
// ============================================================================

/** Notifications the sidecar sends to the frontend */
export const FRONTEND_NOTIFICATIONS = {
  MESSAGE: "message",
  QUERY_ERROR: "queryError",
  ENTER_PLAN_MODE: "enterPlanModeNotification",
  STATUS_CHANGED: "statusChanged",
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
// Zod Schemas (shared — re-exported for backwards compatibility)
// ============================================================================

// Canonical shared schemas — re-exported here for backwards compatibility with
// existing sidecar imports.
export {
  AgentTypeSchema,
  EnterPlanModeNotificationSchema,
  ErrorCategorySchema,
  ErrorResponseSchema,
  MessageResponseSchema,
  SessionStatusSchema,
  StatusChangedNotificationSchema,
};

// ============================================================================
// Inferred Types (from shared schemas re-exported above)
// ============================================================================

import { z } from "zod";

export type AgentType = z.infer<typeof AgentTypeSchema>;
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type MessageResponse = z.infer<typeof MessageResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type EnterPlanModeNotification = z.infer<typeof EnterPlanModeNotificationSchema>;
export type StatusChangedNotification = z.infer<typeof StatusChangedNotificationSchema>;

// ============================================================================
// MCP-Facing RPC Schemas — re-exported from rpc-schemas.ts
// ============================================================================

export * from "./rpc-schemas";
