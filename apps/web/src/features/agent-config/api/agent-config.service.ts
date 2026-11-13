import { api } from "@shared/api";
import type { AgentConfigBySection, AgentConfigSection } from "@shared/types/agent-config";
import { call } from "@/platform/ws";
import type { ConfigScope } from "../types";

/**
 * One section of an agent's configuration, typed by the section asked for:
 * `agentConfig` answers whichever section it was asked, and this is the one
 * place that says so to the compiler.
 */
export function readAgentConfig<Section extends AgentConfigSection>(
  section: Section,
  scope: ConfigScope,
  repoPath?: string
): Promise<AgentConfigBySection[Section]> {
  return call(api.agentConfig, { section, scope, repoPath }) as Promise<
    AgentConfigBySection[Section]
  >;
}
