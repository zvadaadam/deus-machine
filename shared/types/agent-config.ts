/**
 * Agent Config response types — shared between frontend and backend.
 *
 * These describe the shapes returned by the backend config endpoints
 * (GET /config/{category}). Both the backend service functions and
 * the frontend query hooks reference these types.
 *
 * File formats on disk:
 * - Skills: {dir}/skills/{name}/SKILL.md (YAML frontmatter + markdown)
 * - Commands: {dir}/commands/{name}.md (flat markdown)
 * - Agents: {dir}/agents/{name}.json (JSON)
 * - MCP: {dir}/plugins/config.json → mcpServers key (nested JSON)
 * - Hooks: {dir}/settings.json → hooks key (event→handler map)
 */

/** GET /config/skills */
export interface SkillItem {
  name: string;
  description: string;
  content: string;
}

/** GET /config/commands */
export interface CommandItem {
  name: string;
  description: string;
  content: string;
}

/** GET /config/agents */
export interface AgentItem {
  id: string;
  name?: string;
  description?: string;
  tools?: string[];
}

/** GET /config/mcp-servers */
export interface McpServerItem {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Individual hook command within a matcher group */
export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

/** A matcher group containing one or more hook commands */
export interface HookMatcherGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

/** GET /config/hooks — full hooks map (event name → matcher groups) */
export type HooksMap = Record<string, HookMatcherGroup[]>;
