// sidecar/agents/agent-types.ts
// Type definitions for the agent handler interface and related types.
// Extracted from agent-handler.ts for cleaner separation of types vs runtime code.

import type { AgentType, QueryRequest } from "../protocol";

/** Options passed to query(), validated by QueryRequestSchema in protocol.ts */
export type QueryOptions = QueryRequest["options"];

/**
 * Declares which optional features an agent handler supports.
 * Used for capability-based dispatch — call sites check capabilities
 * instead of checking agentType strings or casting to concrete classes.
 */
export interface AgentCapabilities {
  /** Supports auth check (e.g., Claude account info) */
  auth: boolean;
  /** Supports workspace initialization (slash commands, MCP servers) */
  workspaceInit: boolean;
  /** Supports context usage queries */
  contextUsage: boolean;
  /** Supports runtime permission mode changes */
  permissionMode: boolean;
}

// ============================================================================
// Optional method parameter types (provider-neutral names)
// ============================================================================

export interface AuthParams {
  id: string;
  cwd: string;
}

export interface InitWorkspaceParams {
  id: string;
  cwd: string;
  ghToken?: string;
  claudeEnvVars?: string;
}

export interface ContextUsageParams {
  id: string;
  options: { cwd: string; claudeSessionId: string };
}

/**
 * Common interface for all agent handlers.
 *
 * Core lifecycle methods (required):
 * - initialize() — one-time setup (e.g., discover executable)
 * - query() — process a user prompt
 * - cancel() — cancel a running session
 * - reset() — tear down generator for a session
 *
 * Optional provider-specific methods (guarded by capabilities):
 * - auth() — check account auth info
 * - initWorkspace() — get slash commands + MCP server status
 * - getContextUsage() — fetch context window usage
 * - updatePermissionMode() — hot-swap permission mode on active query
 */
export interface AgentHandler {
  readonly agentType: AgentType;
  readonly capabilities: AgentCapabilities;

  initialize(): { success: boolean; error?: string };

  query(sessionId: string, prompt: string, options: QueryOptions): Promise<void>;

  cancel(sessionId: string): Promise<void>;

  reset(sessionId: string): void;

  // Optional provider-specific methods (guarded by capabilities)
  auth?(params: AuthParams): Promise<any>;
  initWorkspace?(params: InitWorkspaceParams): Promise<any>;
  getContextUsage?(params: ContextUsageParams): Promise<any>;
  updatePermissionMode?(sessionId: string, permissionMode: string): Promise<void>;
}
