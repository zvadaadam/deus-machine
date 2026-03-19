/**
 * Agent Config types
 *
 * Response types (SkillItem, CommandItem, etc.) are defined in shared/types/agent-config.ts
 * and re-exported here for convenience. UI-only types (ConfigDisplayItem, ConfigScope,
 * AgentConfigCategory) live here since they're frontend-specific.
 */

// Re-export shared response types so category views can import from one place
export type {
  SkillItem,
  CommandItem,
  AgentItem,
  McpServerItem,
  HookCommand,
  HookMatcherGroup,
  HooksMap,
} from "@shared/types/agent-config";

export type AgentConfigCategory = "skills" | "commands" | "agents" | "mcp" | "hooks";
export type ConfigScope = "global" | "project";

/** Uniform display record — all categories map to this for the UI */
export interface ConfigDisplayItem {
  id: string;
  name: string;
  description: string;
  scope: ConfigScope;
  category: AgentConfigCategory;
  raw: unknown;
}
