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
  /** Read the agent's messages with the work folded (the default) or see the full run. */
  chat_view?: "bubbles" | "full";
  /** Give local chats a tool to message the person while they work. */
  agent_messages?: boolean;

  // Onboarding
  onboarding_completed?: boolean;

  // AI — Claude
  anthropic_api_key?: string;
  /**
   * Default thinking effort for new sessions and model switches (engine
   * vocabulary). `xhigh` is intentionally excluded — not all models support
   * it, so the global default needs to be a level every model can honor.
   * Per-model upgrades happen by the user cycling the indicator.
   */
  default_thinking_level?: "low" | "medium" | "high";

  // AI — Codex
  openai_api_key?: string;

  // Experimental (default: false when absent — opt-in for new users)
  experimental_simulator?: boolean;
  experimental_browser?: boolean;

  // Remote Access
  remote_access_enabled?: boolean;
  /** Keep the computer awake while a device is connected and it's plugged in (default on). */
  remote_keep_awake?: boolean;
}

// Config item types (MCPServer, Command, Agent) moved to shared/types/agent-config.ts
// as McpServerItem, CommandItem, AgentItem — canonical types shared by frontend + backend.

/**
 * Settings section identifiers
 * Used for navigation in settings UI
 */
export type SettingsSection =
  | "account"
  | "general"
  | "github"
  | "browser"
  | "ai"
  | "cloud"
  | "environment"
  | "slack"
  | "experimental"
  | "access";
