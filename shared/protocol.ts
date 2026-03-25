// shared/protocol.ts
// Canonical Zod schemas for the JSON-RPC 2.0 protocol used by
// the agent-server (sidecar) and backend.
//
// Query options and request schemas are used by agent handlers
// (sidecar/agents/registry.ts). Frontend/backend RPC schemas
// (browser, simulator, diff, terminal, plan mode) live in
// sidecar/rpc-schemas.ts and are re-exported via sidecar/protocol.ts.

import { z } from "zod";

import { AgentTypeSchema } from "./enums";

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
// Query Options & Request (used by agent handler interface)
// ============================================================================

/** Options passed alongside a query/turn request. */
export const QueryOptionsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  turnId: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema.optional(),
  providerEnvVars: z.string().optional(),
  ghToken: z.string().optional(),
  deusEnv: z.record(z.string(), z.string()).optional(),
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
