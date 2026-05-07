// shared/agent-catalog.ts
// Shared agent harness and model metadata used by frontend pickers and
// agent-server tooling. Runtime SDK/process implementations live under
// apps/agent-server/agents/.

import type { AgentHarness } from "./enums";
import type { ThinkingLevel } from "./protocol";

export type { AgentHarness } from "./enums";
export type { ThinkingLevel } from "./protocol";

export interface AgentModelOption {
  /** Model identifier sent to the agent-server. */
  readonly model: string;
  /** Human-readable label. */
  readonly label: string;
  /** Show "New" badge in picker. */
  readonly isNew?: boolean;
  /**
   * Ordered thinking levels the user cycles through for this model.
   * Overrides the agent-level default. Empty array hides the thinking indicator.
   */
  readonly thinkingLevels?: readonly ThinkingLevel[];
}

export interface AgentConfig {
  /** DB-compatible agent_harness string (matches sessions.agent_harness). */
  readonly id: AgentHarness;
  /** Human label for display. */
  readonly label: string;
  /** Group header label in model picker dropdown. */
  readonly groupLabel: string;
  /** Label for agent-server debug CLI banners. */
  readonly cliLabel: string;
  /** Short uppercase event prefix for agent-server debug CLI output. */
  readonly eventLabel: string;
  /** Default thinking levels when a model doesn't declare its own. */
  readonly thinkingLevels: readonly ThinkingLevel[];
  /** Available models, in display order. */
  readonly models: readonly AgentModelOption[];
}

export const AGENT_CONFIGS = {
  claude: {
    id: "claude",
    label: "Claude",
    groupLabel: "Claude Code",
    cliLabel: "Claude Code",
    eventLabel: "CLAUDE",
    thinkingLevels: ["LOW", "MEDIUM", "HIGH"],
    models: [
      {
        model: "claude-opus-4-7[1m]",
        label: "Opus 4.7 1M",
        isNew: true,
        thinkingLevels: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
      },
      {
        model: "claude-opus-4-7",
        label: "Opus 4.7",
        isNew: true,
        thinkingLevels: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
      },
      { model: "claude-opus-4-6[1m]", label: "Opus 4.6 1M" },
      { model: "claude-sonnet-4-6", label: "Sonnet 4.6", isNew: true },
      { model: "claude-haiku-4-5", label: "Haiku 4.5", thinkingLevels: [] },
    ],
  },
  "codex-sdk": {
    id: "codex-sdk",
    label: "Codex",
    groupLabel: "Codex",
    cliLabel: "Codex",
    eventLabel: "CODEX",
    thinkingLevels: ["LOW", "MEDIUM", "HIGH"],
    models: [
      { model: "gpt-5.3-codex", label: "GPT-5.3 Codex", isNew: true },
      { model: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
      { model: "gpt-5.3-codex-spark", label: "Codex Spark" },
    ],
  },
  "codex-server": {
    id: "codex-server",
    label: "Codex",
    groupLabel: "Codex",
    cliLabel: "Codex App Server",
    eventLabel: "CODEX-SERVER",
    thinkingLevels: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
    models: [
      { model: "gpt-5.5", label: "GPT-5.5", isNew: true },
      { model: "gpt-5.4", label: "GPT-5.4" },
    ],
  },
} as const satisfies Record<AgentHarness, AgentConfig>;

// User-facing model picker groups. The legacy `codex-sdk` harness remains
// registered in AGENT_CONFIGS for CLI/backend compatibility, but new frontend
// sessions should route Codex through the app-server harness.
export const MODEL_PICKER_GROUPS = [
  AGENT_CONFIGS.claude,
  AGENT_CONFIGS["codex-server"],
] as const satisfies readonly AgentConfig[];

export const DEFAULT_AGENT_HARNESS = "claude" satisfies AgentHarness;
export const DEFAULT_MODEL = `${DEFAULT_AGENT_HARNESS}:${AGENT_CONFIGS[DEFAULT_AGENT_HARNESS].models[0].model}`;

export function getKnownAgentConfig(agentHarness: AgentHarness): AgentConfig {
  return AGENT_CONFIGS[agentHarness];
}

export function getAgentHarnessLabel(agentHarness: AgentHarness): string {
  return AGENT_CONFIGS[agentHarness].cliLabel;
}

export function getAgentHarnessEventLabel(agentHarness: AgentHarness): string {
  return AGENT_CONFIGS[agentHarness].eventLabel;
}
