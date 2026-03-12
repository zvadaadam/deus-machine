// shared/protocol.ts
// Canonical Zod schemas for the JSON-RPC 2.0 request/response protocol
// between the frontend (socketService) and sidecar.
//
// These are RPC contracts (request → response), distinct from the
// notification schemas in session-events.ts (one-way push).

import { z } from "zod";

import { AgentTypeSchema } from "./enums";

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

// ============================================================================
// Query (frontend → sidecar)
// ============================================================================

/** Options passed alongside a query request. */
export const QueryOptionsSchema = z.object({
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
});
export type QueryOptions = z.infer<typeof QueryOptionsSchema>;

export const QueryRequestSchema = z.object({
  type: z.literal("query"),
  id: z.string(),
  agentType: AgentTypeSchema,
  prompt: z.string(),
  options: QueryOptionsSchema,
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

/** Synchronous ACK/reject response for query method. */
export const QueryAckResponseSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type QueryAckResponse = z.infer<typeof QueryAckResponseSchema>;

// ============================================================================
// Cancel (frontend → sidecar)
// ============================================================================

export const CancelRequestSchema = z.object({
  type: z.literal("cancel"),
  id: z.string(),
  agentType: AgentTypeSchema,
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

// ============================================================================
// Claude Auth (frontend → sidecar)
// ============================================================================

export const ClaudeAuthRequestSchema = z.object({
  type: z.literal("claude_auth"),
  id: z.string(),
  agentType: AgentTypeSchema,
  options: z.object({
    cwd: z.string(),
  }),
});
export type ClaudeAuthRequest = z.infer<typeof ClaudeAuthRequestSchema>;

// ============================================================================
// Workspace Init (frontend → sidecar)
// ============================================================================

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
export type WorkspaceInitRequest = z.infer<typeof WorkspaceInitRequestSchema>;

// ============================================================================
// Context Usage (frontend → sidecar)
// ============================================================================

export const ContextUsageRequestSchema = z.object({
  type: z.literal("context_usage"),
  id: z.string(),
  agentType: AgentTypeSchema,
  options: z.object({
    cwd: z.string(),
    claudeSessionId: z.string(),
  }),
});
export type ContextUsageRequest = z.infer<typeof ContextUsageRequestSchema>;

// ============================================================================
// Permission / Reset Notifications (frontend → sidecar, fire-and-forget)
// ============================================================================

export const UpdatePermissionModeRequestSchema = z.object({
  type: z.literal("update_permission_mode"),
  id: z.string(),
  agentType: AgentTypeSchema,
  permissionMode: z.string(),
});
export type UpdatePermissionModeRequest = z.infer<typeof UpdatePermissionModeRequestSchema>;

export const ResetGeneratorRequestSchema = z.object({
  type: z.literal("reset_generator"),
  id: z.string(),
  agentType: AgentTypeSchema,
});
export type ResetGeneratorRequest = z.infer<typeof ResetGeneratorRequestSchema>;

