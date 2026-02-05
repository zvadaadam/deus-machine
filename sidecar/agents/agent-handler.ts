// sidecar/agents/agent-handler.ts
// AgentHandler interface and registry for multi-agent dispatch.
// Each agent type (claude, codex, etc.) implements AgentHandler and
// registers itself in the registry during sidecar startup.

import type { AgentType, QueryRequest } from "../protocol";

/** Options passed to handleQuery, validated by QueryRequestSchema in protocol.ts */
export type QueryOptions = QueryRequest["options"];

/**
 * Common interface for all agent handlers.
 *
 * Each agent implements these 4 lifecycle methods:
 * - initialize() — one-time setup (e.g., discover executable)
 * - handleQuery() — process a user prompt
 * - handleCancel() — cancel a running session
 * - handleReset() — tear down generator for a session
 */
export interface AgentHandler {
  readonly agentType: AgentType;

  initialize(): { success: boolean; error?: string };

  handleQuery(sessionId: string, prompt: string, options: QueryOptions): Promise<void>;

  handleCancel(sessionId: string): Promise<void>;

  handleReset(sessionId: string): void;
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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/**
 * Returns all registered agent types.
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
