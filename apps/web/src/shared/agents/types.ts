// Agent catalog — shared types.
// Pure type declarations, no runtime behavior.

export type AgentHarness = "claude" | "codex";

export type ThinkingLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";

/**
 * A model entry in the picker. Associated with exactly one agent type.
 */
export interface AgentModelOption {
  /** Model identifier sent to the agent-server */
  readonly model: string;
  /** Human-readable label */
  readonly label: string;
  /** Show "New" badge in picker */
  readonly isNew?: boolean;
  /**
   * Ordered thinking levels the user cycles through for this model.
   * Overrides the agent-level default. Empty array hides the thinking indicator.
   */
  readonly thinkingLevels?: readonly ThinkingLevel[];
}

/**
 * Per-agent configuration record.
 *
 * Adding a new agent means adding one entry to AGENT_CONFIGS — UI files
 * consume this data via lookup helpers, so no file-level conditionals.
 */
export interface AgentConfig {
  /** DB-compatible agent_harness string (matches sessions.agent_harness) */
  readonly id: AgentHarness;
  /** Human label for display (e.g. "Claude", "Codex") */
  readonly label: string;
  /** Group header label in model picker dropdown */
  readonly groupLabel: string;
  /** Default thinking levels when a model doesn't declare its own */
  readonly thinkingLevels: readonly ThinkingLevel[];
  /** Available models, in display order */
  readonly models: readonly AgentModelOption[];
}

/**
 * Flat-listed model option derived from an AgentConfig.
 * Used by the picker dropdown and legacy resolvers.
 */
export interface ModelOption {
  /** Unique picker value (harness:model) */
  value: string;
  /** Actual model identifier to send to runtime/backend */
  model: string;
  label: string;
  agentHarness: AgentHarness;
  isNew?: boolean;
}
