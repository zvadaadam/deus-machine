// sidecar/agents/agent-handler.ts
// Agent registry for multi-agent dispatch.
// Each agent type (claude, codex, etc.) implements AgentHandler and
// registers itself in the registry during sidecar startup.
//
// Type definitions live in agent-types.ts; re-exported here for
// backwards compatibility with existing imports.

import { getErrorMessage } from "../../shared/lib/errors";
import type { AgentType } from "../protocol";
import type { AgentHandler } from "./agent-types";

// Re-export all types from agent-types.ts so existing imports don't break
export type {
  AgentHandler,
  AgentCapabilities,
  QueryOptions,
  AuthParams,
  InitWorkspaceParams,
  ContextUsageParams,
} from "./agent-types";

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
