// sidecar/agents/adapters/types.ts
// Shared interfaces for agent message adapters.
// Each agent (Claude, Codex) implements EventTransformer to convert
// its SDK events into our unified ContentBlock[] format.

import type { ContentBlock } from "../../../shared/types/session";

/**
 * Result from finishing event transformation for a turn.
 */
export interface TransformResult {
  /** Normalized content blocks for DB storage */
  blocks: ContentBlock[];
  /** Token usage from the agent SDK */
  usage?: TokenUsage;
  /** Error message if the turn failed */
  error?: string;
}

/**
 * Token usage reported by the agent SDK.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Stateful event transformer that converts agent SDK events into ContentBlocks.
 *
 * Usage:
 *   const transformer = createClaudeTransformer();
 *   for await (const event of sdkStream) {
 *     const blocks = transformer.process(event);
 *     // blocks can be forwarded for streaming UI
 *   }
 *   const { blocks, usage, error } = transformer.finish();
 *   // blocks is the complete set for DB persistence
 */
export interface EventTransformer<TEvent = unknown> {
  /** Process a single SDK event. Returns blocks created or updated. */
  process(event: TEvent): ContentBlock[];

  /** Finalize and return all accumulated blocks + metadata. */
  finish(): TransformResult;
}
