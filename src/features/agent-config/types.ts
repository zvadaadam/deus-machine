/**
 * Agent Config types
 *
 * Each category has a different file format on disk:
 * - Skills: {dir}/skills/{name}/SKILL.md (YAML frontmatter + markdown)
 * - Commands: {dir}/commands/{name}.md (flat markdown)
 * - Agents: {dir}/agents/{name}.json (JSON)
 * - MCP: {dir}/plugins/config.json → mcpServers key (nested JSON)
 * - Hooks: {dir}/settings.json → hooks key (event→handler map)
 *
 * The ConfigDisplayItem provides a uniform shape for the UI.
 */

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

/** What the backend returns for GET /agent-config/skills */
export interface SkillItem {
  name: string;
  description: string;
  content: string;
}

/** What the backend returns for GET /agent-config/commands */
export interface CommandItem {
  name: string;
  description: string;
  content: string;
}

/** What the backend returns for GET /agent-config/agents */
export interface AgentItem {
  id: string;
  name?: string;
  description?: string;
  tools?: string[];
}

/** What the backend returns for GET /agent-config/mcp-servers */
export interface McpServerItem {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What the backend returns for GET /config/hooks — event name → matcher groups */
export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookMatcherGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export type HooksMap = Record<string, HookMatcherGroup[]>;
