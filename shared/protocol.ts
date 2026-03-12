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
// Shared Field Schemas
// ============================================================================

/** Matches the Claude Agent SDK's PermissionMode union type. */
export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

// ============================================================================
// Query (frontend → sidecar)
// ============================================================================

/** Options passed alongside a query request. */
export const QueryOptionsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  turnId: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema.optional(),
  claudeEnvVars: z.string().optional(),
  ghToken: z.string().optional(),
  opendevsEnv: z.record(z.string(), z.string()).optional(),
  additionalDirectories: z.array(z.string()).optional(),
  chromeEnabled: z.boolean().optional(),
  strictDataPrivacy: z.boolean().optional(),
  shouldResetGenerator: z.boolean().optional(),
  resume: z.string().min(1).optional(),
  resumeSessionAt: z.string().min(1).optional(),
});
export type QueryOptions = z.infer<typeof QueryOptionsSchema>;

export const QueryRequestSchema = z.object({
  type: z.literal("query"),
  id: z.string().min(1),
  agentType: AgentTypeSchema,
  prompt: z.string().min(1),
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
  id: z.string().min(1),
  agentType: AgentTypeSchema,
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

// ============================================================================
// Claude Auth (frontend → sidecar)
// ============================================================================

export const ClaudeAuthRequestSchema = z.object({
  type: z.literal("claude_auth"),
  id: z.string().min(1),
  agentType: AgentTypeSchema,
  options: z.object({
    cwd: z.string().min(1),
  }),
});
export type ClaudeAuthRequest = z.infer<typeof ClaudeAuthRequestSchema>;

// ============================================================================
// Workspace Init (frontend → sidecar)
// ============================================================================

export const WorkspaceInitRequestSchema = z.object({
  type: z.literal("workspace_init"),
  id: z.string().min(1),
  agentType: AgentTypeSchema,
  options: z.object({
    cwd: z.string().min(1),
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
  id: z.string().min(1),
  agentType: AgentTypeSchema,
  options: z.object({
    cwd: z.string().min(1),
    claudeSessionId: z.string().min(1),
  }),
});
export type ContextUsageRequest = z.infer<typeof ContextUsageRequestSchema>;

// ============================================================================
// Permission / Reset Notifications (frontend → sidecar, fire-and-forget)
// ============================================================================

export const UpdatePermissionModeRequestSchema = z.object({
  type: z.literal("update_permission_mode"),
  id: z.string().min(1),
  agentType: AgentTypeSchema,
  permissionMode: PermissionModeSchema,
});
export type UpdatePermissionModeRequest = z.infer<typeof UpdatePermissionModeRequestSchema>;

export const ResetGeneratorRequestSchema = z.object({
  type: z.literal("reset_generator"),
  id: z.string().min(1),
  agentType: AgentTypeSchema,
});
export type ResetGeneratorRequest = z.infer<typeof ResetGeneratorRequestSchema>;
