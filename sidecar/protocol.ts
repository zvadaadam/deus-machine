// sidecar/protocol.ts
// Zod-validated protocol definitions for JSON-RPC 2.0 communication
// between the OpenDevs frontend/backend and the sidecar agent runtime.

import { z } from "zod";

// ============================================================================
// RPC Method & Notification Constants
// ============================================================================

/** Methods the frontend can call on the sidecar (request/response) */
export const SIDECAR_METHODS = {
  CANCEL: "cancel",
  CLAUDE_AUTH: "claudeAuth",
  WORKSPACE_INIT: "workspaceInit",
  CONTEXT_USAGE: "contextUsage",
} as const;

/** Notifications the frontend sends to the sidecar (fire-and-forget) */
export const SIDECAR_NOTIFICATIONS = {
  QUERY: "query",
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
} as const;

// ============================================================================
// Zod Schemas
// ============================================================================

export const AgentTypeSchema = z.enum(["claude", "codex", "unknown"]);

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
    conductorEnv: z.record(z.string(), z.string()).optional(),
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
});

export const EnterPlanModeNotificationSchema = z.object({
  type: z.literal("enter_plan_mode_notification"),
  id: z.string(),
  agentType: AgentTypeSchema,
});

// ============================================================================
// Inferred Types
// ============================================================================

export type AgentType = z.infer<typeof AgentTypeSchema>;
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

export function isUpdatePermissionModeRequest(value: unknown): value is UpdatePermissionModeRequest {
  return UpdatePermissionModeRequestSchema.safeParse(value).success;
}

export function isResetGeneratorRequest(value: unknown): value is ResetGeneratorRequest {
  return ResetGeneratorRequestSchema.safeParse(value).success;
}
