import { PublicSettings } from "@shared/types/settings";
import { z } from "zod";
import { ValidationError } from "./errors";

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
export const PreferencesFile = PublicSettings.extend({
  // A newer model can name a level this build does not yet offer.
  default_thinking_level: z.string().optional(),
}).passthrough();

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

// Runtime cloud-credential handoff from the desktop main process. Every
// field optional; `null` clears the value (falls back to env). Values are
// held in backend memory only — never persisted here. `orgKeys` is one device
// key per organization, in the platform's order, and replaces the whole map;
// `orgId` names the default organization.
export const CloudCredentialsBody = z
  .object({
    orgKeys: z.record(z.string().min(1), z.string().min(1)).nullish(),
    baseUrl: z.string().url().nullish(),
    deusCloudUrl: z.string().url().nullish(),
    deusCloudSessionToken: z.string().min(1).nullish(),
    orgId: z.string().min(1).nullish(),
  })
  .strict();

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
