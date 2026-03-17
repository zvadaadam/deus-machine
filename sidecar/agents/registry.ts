// sidecar/agents/registry.ts
// Agent handler interface, type definitions, and runtime registry.
// Each agent type (claude, codex, etc.) implements AgentHandler and
// registers itself in the registry during sidecar startup.

import { getErrorMessage } from "../../shared/lib/errors";
import type { AgentType } from "../protocol";
import type { AgentCapabilities } from "../../shared/agent-events";
import type { QueryOptions } from "../../shared/protocol";

// Re-export so existing imports from registry still work
export type { AgentCapabilities } from "../../shared/agent-events";
export type { QueryOptions } from "../../shared/protocol";

// ============================================================================
// Optional method parameter types (provider-neutral names)
// ============================================================================

export interface AuthParams {
  cwd: string;
}

export interface InitWorkspaceParams {
  cwd: string;
  ghToken?: string;
  providerEnvVars?: string;
}

export interface ContextUsageParams {
  id?: string;
  options: { cwd: string; agentSessionId: string };
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

// ============================================================================
// Agent Registry
// ============================================================================

const registry = new Map<AgentType, AgentHandler>();

/**
 * Registers an agent handler in the registry.
 * Overwrites any existing handler for the same agentType.
 */
export function registerAgent(handler: AgentHandler): void {
  registry.set(handler.agentType, handler);
}

/**
 * Retrieves the agent handler for a given type.
 * Returns undefined if no handler is registered for that type.
 */
export function getAgent(type: AgentType): AgentHandler | undefined {
  return registry.get(type);
}

/**
 * Initializes all registered agents and returns their results.
 * Called once during sidecar startup after all agents are registered.
 */
export function initializeAllAgents(): Map<AgentType, { success: boolean; error?: string }> {
  const results = new Map<AgentType, { success: boolean; error?: string }>();
  for (const [type, handler] of registry) {
    try {
      const result = handler.initialize();
      results.set(type, result);
    } catch (error) {
      results.set(type, {
        success: false,
        error: getErrorMessage(error),
      });
    }
  }
  return results;
}

/**
 * Returns the list of registered agent type names.
 * Used by the health endpoint to report available agents.
 */
export function getRegisteredAgentTypes(): AgentType[] {
  return Array.from(registry.keys());
}

/**
 * Clears the registry. Used in tests to reset state between runs.
 */
export function clearAgentRegistry(): void {
  registry.clear();
}
