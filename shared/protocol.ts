// shared/protocol.ts
// Canonical Zod schemas for the JSON-RPC 2.0 protocol used by
// the agent-server (agent-server) and backend.
//
// Query options and request schemas are used by agent handlers
// (agent-server/agents/registry.ts). Frontend/backend RPC schemas
// (browser, simulator, diff, terminal, plan mode) live in
// agent-server/rpc-schemas.ts and are re-exported via agent-server/protocol.ts.

import { z } from "zod";

import { AgentHarnessSchema } from "./enums";

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

/**
 * User intent for how hard the model should think.
 * Agent-server translates this into SDK-specific options (maxThinkingTokens
 * today, `effort` once the SDK typedef catches up to Opus 4.7's xhigh).
 * Keeps the wire protocol stable across SDK version changes.
 */
export const ThinkingLevelSchema = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "XHIGH"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** Options passed alongside a query/turn request. */
export const QueryOptionsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
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
  agentHarness: AgentHarnessSchema,
  prompt: z.string().min(1),
  options: QueryOptionsSchema,
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;
