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

  // AI — Claude
  anthropic_api_key?: string;
  claude_provider?: string;
  claude_model?: string;
  custom_endpoint?: string;

  // AI — Codex
  openai_api_key?: string;

  // Analytics (opt-out, default true when absent)
  analytics_enabled?: boolean;

  // Experimental (default: false when absent — opt-in for new users)
  experimental_simulator?: boolean;
  experimental_browser?: boolean;
  experimental_design?: boolean;

  // Remote Access
  remote_access_enabled?: boolean;

  // Relay
  relay_server_id?: string;
  relay_token?: string;
}

// Config item types (MCPServer, Command, Agent) moved to shared/types/agent-config.ts
// as McpServerItem, CommandItem, AgentItem — canonical types shared by frontend + backend.

/**
 * Settings section identifiers
 * Used for navigation in settings UI
 */
export type SettingsSection = "general" | "ai" | "environment" | "experimental" | "access";
