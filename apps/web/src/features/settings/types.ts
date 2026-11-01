/**
 * Re-export settings types from shared definitions
 */
export type { Settings, SettingsSection } from "@shared/types/settings";
export type {
  McpServerItem as MCPServer,
  CommandItem as Command,
  AgentItem as Agent,
} from "@shared/types/agent-config";

/** Each local agent's login, as the engine read it from the agent's CLI. */
export type { AgentAuthAnswer } from "@shared/agent-auth";
