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
// Browser Automation Schemas (agent-server → frontend requests)
// ============================================================================

export const BrowserSnapshotRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserSnapshotResponseSchema = z.object({
  snapshot: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserClickRequestSchema = z.object({
  sessionId: z.string(),
  ref: z.string().optional().describe("Element data-cursor-ref to click"),
  x: z.number().optional().describe("X coordinate for coordinate-based click"),
  y: z.number().optional().describe("Y coordinate for coordinate-based click"),
  doubleClick: z.boolean().optional(),
  webviewLabel: z.string().optional(),
});

export const BrowserClickResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserTypeRequestSchema = z.object({
  sessionId: z.string(),
  ref: z.string().describe("Element data-cursor-ref to type into"),
  text: z.string(),
  submit: z.boolean().optional(),
  slowly: z.boolean().optional(),
  webviewLabel: z.string().optional(),
});

export const BrowserTypeResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserNavigateRequestSchema = z.object({
  sessionId: z.string(),
  url: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserNavigateResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  webviewLabel: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserGetStateRequestSchema = z.object({
  sessionId: z.string(),
});

export const BrowserGetStateResponseSchema = z.object({
  available: z.boolean(),
  activeTab: z
    .object({
      webviewLabel: z.string(),
      url: z.string(),
      title: z.string(),
    })
    .optional(),
  hint: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserWaitForRequestSchema = z.object({
  sessionId: z.string(),
  text: z.string().optional().describe("Wait until this text appears on the page"),
  textGone: z.string().optional().describe("Wait until this text disappears from the page"),
  time: z.number().optional().describe("Wait for a fixed number of seconds"),
  timeout: z.number().optional().describe("Maximum wait time in seconds (default: 30)"),
  webviewLabel: z.string().optional(),
});

export const BrowserWaitForResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserEvaluateRequestSchema = z.object({
  sessionId: z.string(),
  code: z.string().describe("JavaScript code to evaluate in the page context"),
  ref: z
    .string()
    .optional()
    .describe("Element ref — if provided, the element is passed as 'element' argument"),
  webviewLabel: z.string().optional(),
});

export const BrowserEvaluateResponseSchema = z.object({
  result: z.string().optional(),
  snapshot: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserPressKeyRequestSchema = z.object({
  sessionId: z.string(),
  key: z.string().describe("Key name (Enter, Tab, Escape, ArrowDown, etc.) or single character"),
  ctrl: z.boolean().optional().describe("Hold Ctrl/Control key"),
  shift: z.boolean().optional().describe("Hold Shift key"),
  alt: z.boolean().optional().describe("Hold Alt/Option key"),
  meta: z.boolean().optional().describe("Hold Meta/Cmd key"),
  webviewLabel: z.string().optional(),
});

export const BrowserPressKeyResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const BrowserHoverRequestSchema = z.object({
  sessionId: z.string(),
  ref: z.string().describe("Element data-cursor-ref to hover over"),
  webviewLabel: z.string().optional(),
});

export const BrowserHoverResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserSelectOptionRequestSchema = z.object({
  sessionId: z.string(),
  ref: z.string().describe("The <select> element's data-cursor-ref"),
  values: z.array(z.string()).describe("Option values or text labels to select"),
  webviewLabel: z.string().optional(),
});

export const BrowserSelectOptionResponseSchema = z.object({
  success: z.boolean(),
  matched: z.number().optional(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserNavigateBackRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserNavigateBackResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserConsoleMessagesRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserConsoleMessagesResponseSchema = z.object({
  logs: z.string(),
  count: z.number(),
  error: z.string().optional(),
});

export const BrowserNetworkRequestsRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
});

export const BrowserNetworkRequestsResponseSchema = z.object({
  requests: z.string(),
  count: z.number(),
  error: z.string().optional(),
});

export const BrowserScrollRequestSchema = z.object({
  sessionId: z.string(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().optional(),
  ref: z.string().optional(),
  webviewLabel: z.string().optional(),
});

export const BrowserScrollResponseSchema = z.object({
  success: z.boolean(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

export const BrowserScreenshotRequestSchema = z.object({
  sessionId: z.string(),
  webviewLabel: z.string().optional(),
  /** Optional crop region in CSS points. When set, only this area is captured. */
  rect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

export const BrowserScreenshotResponseSchema = z.object({
  image: z.string().describe("Base64-encoded PNG screenshot"),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
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
export type BrowserSnapshotRequest = z.infer<typeof BrowserSnapshotRequestSchema>;
export type BrowserSnapshotResponse = z.infer<typeof BrowserSnapshotResponseSchema>;
export type BrowserClickRequest = z.infer<typeof BrowserClickRequestSchema>;
export type BrowserClickResponse = z.infer<typeof BrowserClickResponseSchema>;
export type BrowserTypeRequest = z.infer<typeof BrowserTypeRequestSchema>;
export type BrowserTypeResponse = z.infer<typeof BrowserTypeResponseSchema>;
export type BrowserNavigateRequest = z.infer<typeof BrowserNavigateRequestSchema>;
export type BrowserNavigateResponse = z.infer<typeof BrowserNavigateResponseSchema>;
export type BrowserGetStateRequest = z.infer<typeof BrowserGetStateRequestSchema>;
export type BrowserGetStateResponse = z.infer<typeof BrowserGetStateResponseSchema>;
export type BrowserWaitForRequest = z.infer<typeof BrowserWaitForRequestSchema>;
export type BrowserWaitForResponse = z.infer<typeof BrowserWaitForResponseSchema>;
export type BrowserEvaluateRequest = z.infer<typeof BrowserEvaluateRequestSchema>;
export type BrowserEvaluateResponse = z.infer<typeof BrowserEvaluateResponseSchema>;
export type BrowserPressKeyRequest = z.infer<typeof BrowserPressKeyRequestSchema>;
export type BrowserPressKeyResponse = z.infer<typeof BrowserPressKeyResponseSchema>;
export type BrowserHoverRequest = z.infer<typeof BrowserHoverRequestSchema>;
export type BrowserHoverResponse = z.infer<typeof BrowserHoverResponseSchema>;
export type BrowserSelectOptionRequest = z.infer<typeof BrowserSelectOptionRequestSchema>;
export type BrowserSelectOptionResponse = z.infer<typeof BrowserSelectOptionResponseSchema>;
export type BrowserNavigateBackRequest = z.infer<typeof BrowserNavigateBackRequestSchema>;
export type BrowserNavigateBackResponse = z.infer<typeof BrowserNavigateBackResponseSchema>;
export type BrowserConsoleMessagesRequest = z.infer<typeof BrowserConsoleMessagesRequestSchema>;
export type BrowserConsoleMessagesResponse = z.infer<typeof BrowserConsoleMessagesResponseSchema>;
export type BrowserNetworkRequestsRequest = z.infer<typeof BrowserNetworkRequestsRequestSchema>;
export type BrowserNetworkRequestsResponse = z.infer<typeof BrowserNetworkRequestsResponseSchema>;
export type BrowserScrollRequest = z.infer<typeof BrowserScrollRequestSchema>;
export type BrowserScrollResponse = z.infer<typeof BrowserScrollResponseSchema>;
export type BrowserScreenshotRequest = z.infer<typeof BrowserScreenshotRequestSchema>;
export type BrowserScreenshotResponse = z.infer<typeof BrowserScreenshotResponseSchema>;

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
