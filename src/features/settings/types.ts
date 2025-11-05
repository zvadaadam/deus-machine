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
  notifications_enabled?: boolean;
  sound_effects_enabled?: boolean;
  sound_type?: string;
  diff_view_mode?: string;

  // Account
  user_name?: string;
  user_email?: string;
  user_github_username?: string;
  user_avatar_url?: string;
  anthropic_api_key?: string;

  // Terminal
  terminal_font_size?: number;
  default_open_in?: string;

  // Provider
  claude_provider?: string;
  claude_model?: string;
  custom_endpoint?: string;

  // Memory
  conversation_memory_enabled?: boolean;
  memory_retention?: string;

  // Experimental
  right_panel_visible?: boolean;
  using_split_view?: boolean;
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
 * Event hooks configuration
 * Shell commands triggered by application events
 */
export interface Hook {
  [event: string]: string;
}

/**
 * Settings section identifiers
 * Used for navigation in settings UI
 */
export type SettingsSection =
  | "general"
  | "account"
  | "terminal"
  | "mcp"
  | "commands"
  | "agents"
  | "memory"
  | "hooks"
  | "provider"
  | "experimental";
