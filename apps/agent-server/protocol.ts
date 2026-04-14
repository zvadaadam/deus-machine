// agent-server/protocol.ts
// Protocol definitions for JSON-RPC 2.0 communication between the
// Deus backend and the agent-server agent runtime.
//
// Query/options schemas (QueryRequest, QueryOptions) are canonical in
// shared/protocol.ts. MCP-facing RPC schemas (browser, simulator, diff,
// terminal, plan mode) live in rpc-schemas.ts; re-exported here.

import { AgentTypeSchema, ErrorCategorySchema } from "@shared/enums";
import {
  EnterPlanModeNotificationSchema,
  ErrorResponseSchema,
  MessageResponseSchema,
} from "@shared/session-events";

// Canonical schemas — re-exported for existing agent-server imports.
export { QueryOptionsSchema, QueryRequestSchema } from "@shared/protocol";

export type { QueryOptions, QueryRequest } from "@shared/protocol";

// ============================================================================
// RPC Method & Notification Constants (agent-server-only)
// ============================================================================

/** Notifications the agent-server sends to the frontend */
export const FRONTEND_NOTIFICATIONS = {
  MESSAGE: "message",
  QUERY_ERROR: "queryError",
  ENTER_PLAN_MODE: "enterPlanModeNotification",
} as const;

/** RPC methods the agent-server can call on the frontend (request/response).
 *  Canonical definition in shared/agent-events.ts; re-exported here. */
export { FRONTEND_RPC_METHODS } from "@shared/agent-events";

// ============================================================================
// Zod Schemas (shared — re-exported for backwards compatibility)
// ============================================================================

// Canonical shared schemas — re-exported here for backwards compatibility with
// existing agent-server imports.
export {
  AgentTypeSchema,
  EnterPlanModeNotificationSchema,
  ErrorCategorySchema,
  ErrorResponseSchema,
  MessageResponseSchema,
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

// ============================================================================
// MCP-Facing RPC Schemas — re-exported from rpc-schemas.ts
// ============================================================================

export * from "./rpc-schemas";
