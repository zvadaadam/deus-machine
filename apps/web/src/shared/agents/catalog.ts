// Agent catalog — the single source of truth for which agents/models
// the picker exposes. Purely static data.
//
// Harness lock constraint: once a session has messages, its agent type
// (claude or codex) is fixed — the agent-server binds to a specific SDK
// on first query and cannot switch mid-session. Within the same harness,
// model switching is allowed (e.g. Sonnet → Opus). The UI enforces this
// by disabling cross-group items in the model picker when hasMessages
// is true; see MessageInput's model picker dropdown.

import type { AgentConfig, AgentHarness, ModelOption } from "./types";

export const AGENT_CONFIGS = {
  claude: {
    id: "claude" as const,
    label: "Claude",
    groupLabel: "Claude Code",
    thinkingLevels: ["LOW", "HIGH"] as const,
    models: [
      {
        model: "claude-opus-4-7",
        label: "Opus 4.7",
        isNew: true,
        thinkingLevels: ["LOW", "HIGH", "XHIGH"] as const,
      },
      { model: "claude-opus-4-6", label: "Opus 4.6" },
      { model: "claude-sonnet-4-6", label: "Sonnet 4.6", isNew: true },
      { model: "claude-haiku-4-5", label: "Haiku 4.5", thinkingLevels: [] as const },
    ],
  },
  codex: {
    id: "codex" as const,
    label: "Codex",
    groupLabel: "Codex",
    thinkingLevels: ["LOW", "MEDIUM", "HIGH"] as const,
    models: [
      { model: "gpt-5.3-codex", label: "GPT-5.3 Codex", isNew: true },
      { model: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
      { model: "gpt-5.3-codex-spark", label: "Codex Spark" },
    ],
  },
} satisfies Record<AgentHarness, AgentConfig>;

/** Agent types that appear in the model picker (ordered). */
export const MODEL_PICKER_GROUPS: readonly AgentConfig[] = [
  AGENT_CONFIGS.claude,
  AGENT_CONFIGS.codex,
];

/** Flat model options array, derived from agent configs. */
export const MODEL_OPTIONS: ModelOption[] = MODEL_PICKER_GROUPS.flatMap((config) =>
  config.models.map(
    (m): ModelOption => ({
      value: `${config.id}:${m.model}`,
      model: m.model,
      label: m.label,
      agentHarness: config.id,
      isNew: m.isNew,
    })
  )
);
