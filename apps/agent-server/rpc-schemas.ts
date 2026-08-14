// agent-server/rpc-schemas.ts
// Zod schemas and inferred types for MCP-facing RPC communication
// between the agent-server and frontend (browser automation, simulator,
// diff, terminal, plan mode, user questions).
//
// Extracted from protocol.ts for cleaner separation of constants vs schemas.

import { z } from "zod";
import type { InstalledApp } from "@shared/aap/types";

// ============================================================================
// MCP-Facing RPC Schemas (agent-server → frontend requests/responses)
// ============================================================================

export const AskUserQuestionRequestSchema = z.object({
  sessionId: z.string(),
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()),
      multiSelect: z.boolean().optional(),
    })
  ),
});

export const AskUserQuestionResponseSchema = z.object({
  answers: z.array(z.union([z.string(), z.array(z.string())])),
});

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

export const ExitPlanModeRequestSchema = z.object({
  sessionId: z.string(),
  toolInput: z.unknown(),
});

export const ExitPlanModeResponseSchema = z.object({
  approved: z.boolean(),
  turnId: z.string().optional(),
});

// ============================================================================
// AAP (Agentic Apps) Schemas
//
// Two directions:
//   - Outbound (agent-server → backend): the 3 deus-tools call into apps.service
//     via these RPCs: `aap/list-apps`, `aap/launch-app`, `aap/stop-app`.
//   - Inbound (backend → agent-server): `aap/register-mcp`, `aap/unregister-mcp`
//     — the mcp-bridge fires these when an app transitions to "ready" / exits,
//     and the registrar calls `query.setMcpServers` on every active Claude Query.
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

// --- Inbound (backend → agent-server) ---

export const RegisterAppMcpRequestSchema = z.object({
  serverName: z.string(),
  url: z.string(),
});

export const RegisterAppMcpResponseSchema = z.object({
  added: z.array(z.string()),
  errors: z.record(z.string(), z.string()).optional(),
});

export const UnregisterAppMcpRequestSchema = z.object({
  serverName: z.string(),
});

export const UnregisterAppMcpResponseSchema = z.object({
  removed: z.array(z.string()),
});

// ============================================================================
// Inferred Types (agent-server-local schemas only; RPC types re-exported in protocol.ts)
// ============================================================================

export type AskUserQuestionRequest = z.infer<typeof AskUserQuestionRequestSchema>;
export type AskUserQuestionResponse = z.infer<typeof AskUserQuestionResponseSchema>;
export type GetDiffRequest = z.infer<typeof GetDiffRequestSchema>;
export type GetDiffResponse = z.infer<typeof GetDiffResponseSchema>;
export type DiffCommentRequest = z.infer<typeof DiffCommentRequestSchema>;
export type DiffCommentResponse = z.infer<typeof DiffCommentResponseSchema>;
export type GetTerminalOutputRequest = z.infer<typeof GetTerminalOutputRequestSchema>;
export type GetTerminalOutputResponse = z.infer<typeof GetTerminalOutputResponseSchema>;
export type ExitPlanModeRequest = z.infer<typeof ExitPlanModeRequestSchema>;
export type ExitPlanModeResponse = z.infer<typeof ExitPlanModeResponseSchema>;

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
export type RegisterAppMcpRequest = z.infer<typeof RegisterAppMcpRequestSchema>;
export type RegisterAppMcpResponse = z.infer<typeof RegisterAppMcpResponseSchema>;
export type UnregisterAppMcpRequest = z.infer<typeof UnregisterAppMcpRequestSchema>;
export type UnregisterAppMcpResponse = z.infer<typeof UnregisterAppMcpResponseSchema>;
