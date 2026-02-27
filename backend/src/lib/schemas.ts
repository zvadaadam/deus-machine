import { z } from 'zod';

// ============================================================================
// Config Schemas
// ============================================================================

export const McpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
}).passthrough();

export const SaveMcpServersBody = z.object({
  servers: z.array(McpServerSchema),
});

export const SaveCommandBody = z.object({
  name: z.string().min(1, 'name is required'),
  content: z.string().min(1, 'content is required'),
});

export const SaveAgentBody = z.object({
  id: z.string().min(1, 'id is required'),
}).passthrough();

export const SaveHooksBody = z.object({
  hooks: z.record(z.string(), z.unknown()),
});

// ============================================================================
// Session Schemas
// ============================================================================

export const CreateMessageBody = z.object({
  content: z.string().min(1, 'content is required'),
  model: z.string().optional(),
});

// ============================================================================
// Repo Schemas
// ============================================================================

export const CreateRepoBody = z.object({
  root_path: z.string().min(1, 'root_path is required'),
});

// ============================================================================
// Workspace Schemas
// ============================================================================

const WorkspaceState = z.enum([
  'initializing', 'ready', 'working', 'error', 'archived',
]);

export const PatchWorkspaceBody = z.object({
  state: WorkspaceState.optional(),
});

export const CreateWorkspaceBody = z.object({
  repository_id: z.string().min(1, 'repository_id is required'),
});

export const OpenPenFileBody = z.object({
  filePath: z.string().min(1, 'filePath is required'),
});

// ============================================================================
// Config File Schemas (disk reads — used with safeParse for graceful fallback)
// ============================================================================

/** Shape of a single MCP server entry in ~/.claude/plugins/config.json */
const McpServerConfigEntry = z.object({
  command: z.string(),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
}).passthrough();

/** Top-level shape of ~/.claude/plugins/config.json */
export const McpConfigFile = z.object({
  mcpServers: z.record(z.string(), McpServerConfigEntry).optional().default({}),
}).passthrough();

/** Shape of a single agent JSON file from ~/.claude/agents/*.json */
export const AgentConfigFile = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
}).passthrough();

/** Top-level shape of ~/.claude/settings.json (for hooks extraction) */
export const SettingsFile = z.object({
  hooks: z.record(z.string(), z.unknown()).optional().default({}),
}).passthrough();

// ============================================================================
// Preferences File Schema (disk reads — used with safeParse for graceful fallback)
// ============================================================================

/** Shape of ~/Library/Application Support/com.opendevs.app/preferences.json */
export const PreferencesFile = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  diff_view_mode: z.string().optional(),
  user_name: z.string().optional(),
  onboarding_completed: z.boolean().optional(),
  anthropic_api_key: z.string().optional(),
  claude_provider: z.string().optional(),
  claude_model: z.string().optional(),
  custom_endpoint: z.string().optional(),
  experimental_simulator: z.boolean().optional(),
  experimental_browser: z.boolean().optional(),
  experimental_notebooks: z.boolean().optional(),
  experimental_design: z.boolean().optional(),
}).passthrough();

// ============================================================================
// Auth Schemas
// ============================================================================

export const PairBody = z.object({
  code: z.string().min(1, 'code is required'),
  deviceName: z.string().optional(),
});

// ============================================================================
// Settings Schemas
// ============================================================================

export const SaveSettingBody = z.object({
  key: z.string().min(1, 'key is required'),
  value: z.unknown(),
});
