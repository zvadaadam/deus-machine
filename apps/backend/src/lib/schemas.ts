import { z } from "zod";
import { WorkspaceStateSchema, WorkspaceStatusSchema } from "@shared/enums";
import { ValidationError } from "./errors";

// ============================================================================
// Config Schemas
// ============================================================================

export const McpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

export const SaveMcpServersBody = z.object({
  servers: z.array(McpServerSchema),
});

export const SaveCommandBody = z.object({
  name: z.string().min(1, "name is required"),
  content: z.string().min(1, "content is required"),
});

export const SaveAgentBody = z.object({
  id: z.string().min(1, "id is required"),
  name: z.string().optional(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

const HookCommand = z
  .object({
    type: z.string().optional(),
    command: z.string(),
    timeout: z.number().optional(),
  })
  .passthrough();

const HookMatcherGroup = z
  .object({
    matcher: z.string().optional(),
    hooks: z.array(HookCommand).optional(),
  })
  .passthrough();

export const SaveHooksBody = z.object({
  hooks: z.record(z.string(), z.array(HookMatcherGroup)),
});

export const SaveSkillBody = z.object({
  name: z.string().min(1, "name is required"),
  content: z.string().min(1, "content is required"),
});

// ============================================================================
// Repo Schemas
// ============================================================================

export const CreateRepoBody = z.object({
  root_path: z.string().min(1, "root_path is required"),
});

const TemplateUrl = z.string().regex(/^https:\/\/[^\s;|&`$()]+$/, "Only HTTPS URLs are allowed");

export const InitProjectBody = z.object({
  projectName: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Invalid project name"),
  targetPath: z.string().min(1),
  template: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("empty") }),
      z.object({ type: z.literal("github"), url: TemplateUrl }),
    ])
    .optional(),
});

// ============================================================================
// Workspace Schemas
// ============================================================================

// WorkspaceStateSchema imported from shared/enums.ts — single source of truth.
// Previously had a local 5-value enum including "working" which doesn't belong
// in workspace state (that's a session status).

export const PatchWorkspaceBody = z.object({
  state: WorkspaceStateSchema.optional(),
  status: WorkspaceStatusSchema.optional(),
});

export const CreateWorkspaceBody = z.object({
  repository_id: z.string().min(1, "repository_id is required"),
  /** Where the workspace's files live: local git worktree (default) or an
   *  agnt cloud sandbox. */
  location: z.enum(["local", "cloud"]).optional(),
  source_branch: z
    .string()
    .refine((s) => !s.startsWith("-"), "Branch name must not start with a dash")
    .optional(), // remote branch to base worktree on
  pr_number: z.number().int().positive().optional(), // pre-populate PR tracking
  pr_url: z.string().url().optional(),
  pr_title: z.string().optional(),
  target_branch: z
    .string()
    .refine((s) => !s.startsWith("-"), "Branch name must not start with a dash")
    .optional(), // PR's base branch (for diff target)
});

export const OpenPenFileBody = z.object({
  filePath: z.string().min(1, "filePath is required"),
});

// ============================================================================
// Config File Schemas (disk reads — used with safeParse for graceful fallback)
// ============================================================================

/** Shape of a single MCP server entry in ~/.claude/plugins/config.json */
const McpServerConfigEntry = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string(), z.string()).optional().default({}),
  })
  .passthrough();

/** Top-level shape of ~/.claude/plugins/config.json */
export const McpConfigFile = z
  .object({
    mcpServers: z.record(z.string(), McpServerConfigEntry).optional().default({}),
  })
  .passthrough();

/** Shape of a single agent JSON file from ~/.claude/agents/*.json */
export const AgentConfigFile = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

/** Top-level shape of ~/.claude/settings.json (for hooks extraction) */
export const SettingsFile = z
  .object({
    hooks: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();

// ============================================================================
// Preferences File Schema (disk reads — used with safeParse for graceful fallback)
// ============================================================================

/** Shape of ~/Library/Application Support/com.deus.app/preferences.json */
export const PreferencesFile = z
  .object({
    theme: z.enum(["light", "dark", "system"]).optional(),
    diff_view_mode: z.string().optional(),
    onboarding_completed: z.boolean().optional(),
    anthropic_api_key: z.string().optional(),
    claude_provider: z.string().optional(),
    claude_model: z.string().optional(),
    custom_endpoint: z.string().optional(),
    // Engine vocabulary (lowercase). Files written by older builds carry the
    // retired UPPERCASE spellings — normalized on read, see readThinkingLevel.
    default_thinking_level: z.string().optional(),
    experimental_simulator: z.boolean().optional(),
    experimental_browser: z.boolean().optional(),
    experimental_design: z.boolean().optional(),
    experimental_apps: z.boolean().optional(),
  })
  .passthrough();

// ============================================================================
// Auth Schemas
// ============================================================================

export const PairBody = z.object({
  code: z.string().min(1, "code is required"),
  deviceName: z.string().optional(),
});

// ============================================================================
// Settings Schemas
// ============================================================================

export const SaveSettingBody = z.object({
  key: z.string().min(1, "key is required"),
  value: z.unknown(),
});

// Runtime cloud-credential handoff from the desktop main process. Every
// field optional; `null` clears the value (falls back to env). Values are
// held in backend memory only — never persisted here.
export const CloudCredentialsBody = z.object({
  apiKey: z.string().min(1).nullish(),
  baseUrl: z.string().url().nullish(),
  anthropicApiKey: z.string().min(1).nullish(),
  claudeOauthToken: z.string().min(1).nullish(),
  deusCloudUrl: z.string().url().nullish(),
  deusCloudSessionToken: z.string().min(1).nullish(),
  orgId: z.string().min(1).nullish(),
});

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Parse and validate data against a Zod schema.
 * Throws ValidationError with descriptive messages on failure.
 */
export function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `${path}${i.message}`;
    });
    throw new ValidationError(messages.join("; "));
  }
  return result.data;
}
