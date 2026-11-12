/**
 * An agent's configuration, as the backend reads it from Claude Code's files
 * and as the `agentConfig` operations carry it (`shared/api/settings.ts`).
 *
 * File formats on disk:
 * - Skills: {dir}/skills/{name}/SKILL.md (YAML frontmatter + markdown)
 * - Commands: {dir}/commands/{name}.md (flat markdown)
 * - Agents: {dir}/agents/{name}.json (JSON)
 * - MCP: {dir}/plugins/config.json → mcpServers key (nested JSON)
 * - Hooks: {dir}/settings.json → hooks key (event→handler map)
 */

import { z } from "zod";

export interface SkillItem {
  name: string;
  description: string;
  content: string;
}

export interface CommandItem {
  name: string;
  description: string;
  content: string;
}

export interface AgentItem {
  id: string;
  name?: string;
  description?: string;
  tools?: string[];
}

export interface McpServerItem {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

// Hooks are Claude Code's own format and are saved whole, so a field Deus does
// not edit (another hook type, a field added later) is kept as it was read.
const HookCommandSchema = z.looseObject({
  type: z.string().optional(),
  command: z.string(),
  timeout: z.number().optional(),
});

const HookMatcherGroupSchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(HookCommandSchema).optional(),
});

/** Every hook: event name → matcher groups. */
export const HooksMapSchema = z.record(z.string(), z.array(HookMatcherGroupSchema));

/** Individual hook command within a matcher group */
export type HookCommand = z.infer<typeof HookCommandSchema>;
/** A matcher group containing one or more hook commands */
export type HookMatcherGroup = z.infer<typeof HookMatcherGroupSchema>;
export type HooksMap = z.infer<typeof HooksMapSchema>;

/** What each section of the configuration reads as. */
export interface AgentConfigBySection {
  "mcp-servers": McpServerItem[];
  commands: CommandItem[];
  agents: AgentItem[];
  hooks: HooksMap;
  skills: SkillItem[];
}
export type AgentConfigSection = keyof AgentConfigBySection;
