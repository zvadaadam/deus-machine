// agent-server/messages/index.ts
// Unified message transformation layer.
//
// Adapters transform provider-specific SDK events (Claude, Codex) into
// canonical Parts that the backend can persist and the frontend can render
// without any provider-specific parsing.

// Adapter interface
export type { Adapter, EventTransformer, StreamContext } from "./adapter";

// Provider adapters
export { claudeCodeAdapter } from "./claude-adapter";
export { codexAdapter } from "./codex-adapter";
export { codexSdkAdapter } from "./codex-sdk-adapter";

// Raw event types
export type { ClaudeCodeEvent } from "./claude-events";
export type { CodexEvent } from "./codex-events";
export { CodexEventSchema } from "./codex-events";

// Part factories and helpers
export {
  appendToolInput,
  completeToolPart,
  createCompactionPart,
  createPendingToolPart,
  createReasoningPart,
  createStepFinishPart,
  createStepStartPart,
  createTextPart,
  createToolPart,
  startToolPart,
} from "./parts";
