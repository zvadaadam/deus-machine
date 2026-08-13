// shared/protocol.ts
// Canonical Zod schemas for the JSON-RPC 2.0 protocol used by
// the agent-server (agent-server) and backend.
//
// Query options and request schemas are used by agent handlers
// (agent-server/agents/registry.ts). Frontend/backend RPC schemas
// (browser, simulator, diff, terminal, plan mode) live in
// agent-server/rpc-schemas.ts and are re-exported via agent-server/protocol.ts.

import { z } from "zod";

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
// Thinking Level
// ============================================================================

/**
 * User intent for how hard the model should think.
 * The backend translates this stable wire value into the engine's vocabulary.
 */
export const ThinkingLevelSchema = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "XHIGH"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
