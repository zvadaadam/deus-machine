// Agent catalog — lookup helpers.
// Pure functions over static catalog data.

import { AGENT_CONFIGS, MODEL_OPTIONS } from "./catalog";
import type { AgentConfig, AgentHarness, ModelOption } from "./types";

/**
 * Resolve an agent config by type.
 * Falls back to Claude for unknown types; logs a dev-only warning so drift
 * from the catalog doesn't silently misroute users in production.
 */
export function getAgentConfig(agentHarness: string): AgentConfig {
  const normalized = agentHarness.toLowerCase() as AgentHarness;
  const config = AGENT_CONFIGS[normalized];
  if (!config) {
    if (import.meta.env.DEV) {
      console.warn(`[agents] Unknown agent type "${agentHarness}", defaulting to claude.`);
    }
    return AGENT_CONFIGS.claude;
  }
  return config;
}

export function getAgentLabel(agentHarness: string): string {
  return getAgentConfig(agentHarness).label;
}

/**
 * Resolve a runtime model option by its `harness:model` value.
 * Returns undefined for unrecognized values.
 */
export function getModelOption(model: string): ModelOption | undefined {
  const normalized = model.toLowerCase().trim();
  return MODEL_OPTIONS.find((option) => option.value === normalized);
}

export function getModelLabel(model: string): string {
  return getModelOption(model)?.label ?? model;
}

export function getAgentHarnessForModel(model: string): AgentHarness {
  const option = getModelOption(model);
  if (option) return option.agentHarness;
  // Unknown models: use the harness prefix if present, default to claude.
  return model.toLowerCase().startsWith("codex:") ? "codex" : "claude";
}

export function getModelId(model: string): string {
  return getModelOption(model)?.model ?? "claude-opus-4-7";
}
