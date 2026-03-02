/**
 * Settings-related TypeScript type definitions
 * Types for application configuration and preferences
 */

/**
 * Application settings
 * User preferences and configuration options
 */
export interface Settings {
  // General
  theme?: "light" | "dark" | "system";
  diff_view_mode?: string;
  user_name?: string;

  // Onboarding
  onboarding_completed?: boolean;

  // AI
  anthropic_api_key?: string;
  claude_provider?: string;
  claude_model?: string;
  custom_endpoint?: string;

  // Analytics (opt-out, default true when absent)
  analytics_enabled?: boolean;

  // Experimental (default: false when absent — opt-in for new users)
  experimental_simulator?: boolean;
  experimental_browser?: boolean;
  experimental_notebooks?: boolean;
  experimental_design?: boolean;

  // Messaging Gateway
  telegram_bot_token?: string;
  whatsapp_session_dir?: string;
  gateway_enabled?: boolean;
  gateway_allowed_user_ids?: string;

  // Remote Access
  remote_access_enabled?: boolean;

  // Relay
  relay_server_id?: string;
  relay_token?: string;
  relay_url?: string; // e.g., "wss://relay.opendevs.sh"
}

/**
 * MCP (Model Context Protocol) Server configuration
 * Configures external context providers for Claude
 */
export interface MCPServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Custom slash command definition
 * User-defined commands for quick actions
 */
export interface Command {
  name: string;
  description: string;
  content: string;
}

/**
 * Agent configuration
 * Sub-agents that can be invoked by Claude
 */
export interface Agent {
  id: string;
  name: string;
  description: string;
  tools: string[];
}

/**
 * Settings section identifiers
 * Used for navigation in settings UI
 */
export type SettingsSection =
  | "general"
  | "ai"
  | "extensions"
  | "environment"
  | "experimental"
  | "access"
  | "updates";
