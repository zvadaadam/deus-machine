// agent-server/rpc-schemas.ts
// Zod schemas and inferred types for the deus MCP tools' requests to the
// backend (diff, terminal, apps, automations).
//
// Extracted from protocol.ts for cleaner separation of constants vs schemas.

import { z } from "zod";
import type { InstalledApp } from "@shared/aap/types";

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
// AAP (Agentic Apps) Schemas
//
// The deus-tools call into apps.service through the backend: `aap/list-apps`,
// `aap/launch-app`, `aap/stop-app`, `aap/read-app-skill`. (An app's MCP server
// reaches the engine directly: the mcp-bridge calls `registerAppMcp`.)
// ============================================================================

/** Wire-schema for one installed-app row. The `satisfies` clause binds it to
 *  the canonical `InstalledApp` interface in `shared/aap/types.ts` — if the
 *  interface grows a field, this schema must grow too or TypeScript fails
 *  right here. Single source of truth is the TS interface; this is its
 *  runtime-validated mirror for the agent-server RPC boundary. */
export const InstalledAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  icon: z.string().optional(),
  bootstrap: z.string().optional(),
}) satisfies z.ZodType<InstalledApp>;

// AAP RPCs carry `sessionId` — the agent always has it from the tool's
// closure. The backend resolves it to the session's workspace, so Claude
// never has to guess a workspaceId it doesn't have. Applies to list_apps
// and launch_app.
export const ListAppsRequestSchema = z.object({
  sessionId: z.string(),
});

export const ListAppsResponseSchema = z.object({
  apps: z.array(InstalledAppSchema),
  runningAppIds: z.array(z.string()),
});

export const LaunchAppRequestSchema = z.object({
  appId: z.string(),
  sessionId: z.string(),
});

export const LaunchAppResponseSchema = z.object({
  runningAppId: z.string(),
  url: z.string(),
  bootstrap: z.string().optional(),
});

export const StopAppRequestSchema = z.object({
  runningAppId: z.string(),
});

export const StopAppResponseSchema = z.object({
  success: z.boolean(),
});

export const ReadAppSkillRequestSchema = z.object({
  appId: z.string(),
});

export const ReadAppSkillResponseSchema = z.object({
  /** Concatenated markdown of every skill file the manifest declares, with
   *  `# <path>` dividers. Empty string when the manifest has no skills. */
  content: z.string(),
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

// `InstalledApp` is canonical in shared/aap/types.ts — re-exported here so
// existing `import { InstalledApp } from "./rpc-schemas"` call sites keep
// working without a second source of truth.
export type { InstalledApp } from "@shared/aap/types";
export type ListAppsRequest = z.infer<typeof ListAppsRequestSchema>;
export type ListAppsResponse = z.infer<typeof ListAppsResponseSchema>;
export type LaunchAppRequest = z.infer<typeof LaunchAppRequestSchema>;
export type LaunchAppResponse = z.infer<typeof LaunchAppResponseSchema>;
export type StopAppRequest = z.infer<typeof StopAppRequestSchema>;
export type StopAppResponse = z.infer<typeof StopAppResponseSchema>;
export type ReadAppSkillRequest = z.infer<typeof ReadAppSkillRequestSchema>;
export type ReadAppSkillResponse = z.infer<typeof ReadAppSkillResponseSchema>;
export type AutomationUpdateRequest = z.infer<typeof AutomationUpdateRequestSchema>;
export type AutomationUpdateResponse = z.infer<typeof AutomationUpdateResponseSchema>;
