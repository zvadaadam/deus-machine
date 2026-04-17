// Agent catalog — public surface.
// Static data + pure helpers describing which agents/models the UI exposes.
// The server-side runtime (agent handlers, SDK option translation) lives in
// apps/agent-server/agents/.

export type {
  AgentHarness,
  ThinkingLevel,
  AgentConfig,
  AgentModelOption,
  ModelOption,
} from "./types";

export { AGENT_CONFIGS, MODEL_PICKER_GROUPS, MODEL_OPTIONS } from "./catalog";

export {
  getAgentLabel,
  getModelOption,
  getModelLabel,
  getAgentHarnessForModel,
  getModelId,
} from "./lookup";

export { cycleThinkingLevel, getThinkingLevelsForModel, clampThinkingLevel } from "./thinking";
