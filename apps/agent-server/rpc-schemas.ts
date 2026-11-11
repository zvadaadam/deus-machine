// agent-server/rpc-schemas.ts
// Zod schemas and inferred types for the deus MCP tools' requests to the
// backend (diff, terminal, automations).
//
// Extracted from protocol.ts for cleaner separation of constants vs schemas.

import { z } from "zod";

// ============================================================================
// MCP-Facing RPC Schemas (agent-server → frontend requests/responses)
// ============================================================================

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

// ============================================================================
// Automations
//
// One mode-discriminated request (the ChatGPT `automation_update` shape). The
// backend resolves the repository from the calling session, so the agent never
// guesses ids it doesn't have. The model and thinking level are the agent's to
// name — nothing fills them in — from what mode=models lists.
// ============================================================================

export const AutomationUpdateRequestSchema = z.object({
  sessionId: z.string(),
  /** `models`: the Claude models Deus Cloud runs, with each one's thinking levels. */
  mode: z.enum(["list", "view", "create", "update", "delete", "models"]),
  /** Automation id (preferred) or exact name. Required for view/update/delete. */
  automationId: z.string().optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  /** 5-field cron expression (e.g. "0 9 * * 1-5"). ≥5 minutes between fires. */
  cron: z.string().optional(),
  /** IANA timezone; omitted = UTC. */
  timezone: z.string().nullable().optional(),
  sessionPolicy: z.enum(["fresh_session", "same_session"]).optional(),
  model: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
  status: z.enum(["active", "paused"]).optional(),
});

/** Loose on purpose: the backend returns wire `Automation` rows (shared/types)
 *  and the tool renders them as JSON — no second schema to drift. */
export const AutomationUpdateResponseSchema = z.object({
  automations: z.array(z.unknown()).optional(),
  automation: z.unknown().optional(),
  deleted: z.boolean().optional(),
  models: z.array(z.unknown()).optional(),
});

// ============================================================================
// Inferred Types (agent-server-local schemas only; RPC types re-exported in protocol.ts)
// ============================================================================

export type GetDiffRequest = z.infer<typeof GetDiffRequestSchema>;
export type GetDiffResponse = z.infer<typeof GetDiffResponseSchema>;
export type DiffCommentRequest = z.infer<typeof DiffCommentRequestSchema>;
export type DiffCommentResponse = z.infer<typeof DiffCommentResponseSchema>;
export type GetTerminalOutputRequest = z.infer<typeof GetTerminalOutputRequestSchema>;
export type GetTerminalOutputResponse = z.infer<typeof GetTerminalOutputResponseSchema>;
export type AutomationUpdateRequest = z.infer<typeof AutomationUpdateRequestSchema>;
export type AutomationUpdateResponse = z.infer<typeof AutomationUpdateResponseSchema>;
