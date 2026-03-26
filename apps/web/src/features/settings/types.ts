/**
 * Re-export settings types from shared definitions
 */
export type { Settings, SettingsSection } from "@shared/types/settings";
export type {
  McpServerItem as MCPServer,
  CommandItem as Command,
  AgentItem as Agent,
} from "@shared/types/agent-config";

/** Auth status returned by the agent-server for each provider */
export interface AgentProviderAuth {
  type: string;
  agentType: string;
  accountInfo?: {
    email?: string;
    orgName?: string;
    [key: string]: unknown;
  };
  error?: string;
}

export interface AgentInstallInfo {
  type: string;
  installed: boolean;
}

export interface AgentAuthStatus {
  agents: AgentInstallInfo[];
  claude: AgentProviderAuth | null;
  codex: AgentProviderAuth | null;
  error?: string;
}
