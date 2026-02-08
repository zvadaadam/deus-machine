// sidecar/agents/claude/claude-adapter.ts
// Claude Code adapter — converts Claude Agent SDK events into ContentBlock[].
//
// STATUS: Scaffolding — not wired into claude-handler.ts yet.
//
// Currently the Claude handler passes raw SDK messages directly to saveAssistantMessage()
// because Claude SDK already emits ContentBlock-compatible content arrays. This adapter
// exists as scaffolding for when we need:
//
// 1. Unified streaming normalization — emit the same event shape for Claude and Codex
//    to the frontend, instead of raw agent-specific events (see Echo backend's
//    message.part.delta vs message.part separation)
//
// 2. Stream event handling — Claude SDK also emits lower-level `stream_event` types
//    (content_block_start, content_block_delta, content_block_stop, input_json_delta)
//    that enable real-time tool input streaming. Echo's claude-code.ts adapter buffers
//    partial JSON fragments from input_json_delta and reassembles them on content_block_stop.
//    This adapter only handles high-level events (assistant, user, result) — stream events
//    would need to be added here.
//
// 3. Batch-per-turn persistence — accumulate all blocks across events, save once at turn
//    end (like codex-handler already does). Currently claude-handler saves per-SDK-event
//    (N rows per turn), which works but differs from the Codex pattern.
//
// 4. Tool state tracking — pending → running → completed transitions for UI indicators
//    (Echo uses a 7-state DB model for full approval flow tracking).
//
// Reference: Echo backend's adapter at sample-backend/src/messages/adapters/claude-code.ts
// implements the full version of this pattern with stream event buffering and delta emission.
//
// What this adapter handles today (high-level events only):
// - "assistant" events: extract content blocks from the SDK message envelope
// - "user" events: extract tool_result blocks to complete tool_use ↔ tool_result pairs
// - "result" events: capture token usage and error status

import type { ContentBlock } from "../../../shared/types/session";
import type { EventTransformer, TransformResult, TokenUsage } from "../adapters/types";

// ============================================================================
// Claude SDK Event Types (subset relevant for transformation)
// ============================================================================

interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: ContentBlock[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface ClaudeUserEvent {
  type: "user";
  message: {
    role: "user";
    content:
      | string
      | Array<
          | ContentBlock
          | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
        >;
  };
}

interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

interface ClaudeSystemEvent {
  type: "system";
}

/** Union of all Claude SDK event types we handle */
export type ClaudeSDKEvent =
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeSystemEvent
  | { type: string }; // catch-all for stream_event and other types we pass through

// ============================================================================
// Transformer
// ============================================================================

/**
 * Creates a Claude event transformer.
 *
 * For Claude, the transformation is thin because the SDK already emits ContentBlock[]:
 * - "assistant" events: extract the content blocks array directly
 * - "user" events: extract tool_result blocks to complete tool pairs
 * - "result" events: capture token usage and error status
 * - All other events: ignored for persistence (forwarded raw for streaming)
 *
 * Lifecycle caveat: this accumulator grows unboundedly across a multi-turn session.
 * Claude's handler uses a long-lived async generator — the same generator processes
 * turns 1, 2, 3, etc. If wired in, a new transformer must be created per turn (not
 * per session), or allBlocks must be cleared between turns. The Codex adapter doesn't
 * have this issue because Codex spawns a fresh child process per query.
 */
export function createClaudeTransformer(): EventTransformer<ClaudeSDKEvent> {
  const allBlocks: ContentBlock[] = [];
  let usage: TokenUsage | undefined;
  let error: string | undefined;

  return {
    process(event: ClaudeSDKEvent): ContentBlock[] {
      switch (event.type) {
        case "assistant": {
          const assistantEvent = event as ClaudeAssistantEvent;
          const content = assistantEvent.message?.content;
          if (Array.isArray(content)) {
            allBlocks.push(...content);
            return content;
          }
          return [];
        }

        case "user": {
          const userEvent = event as ClaudeUserEvent;
          const content = userEvent.message?.content;
          if (Array.isArray(content)) {
            const toolResults: ContentBlock[] = [];
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                "type" in block &&
                block.type === "tool_result"
              ) {
                const resultBlock: ContentBlock = {
                  type: "tool_result",
                  tool_use_id: (block as { tool_use_id: string }).tool_use_id,
                  content: (block as { content: string }).content,
                  is_error: (block as { is_error: boolean }).is_error,
                };
                allBlocks.push(resultBlock);
                toolResults.push(resultBlock);
              }
            }
            return toolResults;
          }
          return [];
        }

        case "result": {
          const resultEvent = event as ClaudeResultEvent;
          if (resultEvent.usage) {
            usage = {
              inputTokens: resultEvent.usage.input_tokens,
              outputTokens: resultEvent.usage.output_tokens,
              cacheReadTokens: resultEvent.usage.cache_read_input_tokens,
              cacheWriteTokens: resultEvent.usage.cache_creation_input_tokens,
            };
          }
          if (
            resultEvent.subtype === "error_max_turns" ||
            resultEvent.subtype === "error_during_execution"
          ) {
            error = `Execution ended with: ${resultEvent.subtype}`;
          }
          return [];
        }

        default:
          return [];
      }
    },

    finish(): TransformResult {
      return { blocks: allBlocks, usage, error };
    },
  };
}
