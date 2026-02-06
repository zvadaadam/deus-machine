// sidecar/agents/claude/claude-adapter.ts
// Claude Code adapter — converts Claude Agent SDK events into ContentBlock[].
//
// Claude SDK messages already contain ContentBlock-compatible content arrays,
// so this adapter is mostly pass-through extraction. The main work is:
// 1. Extracting content blocks from the { type: "assistant", message: { content: [...] } } envelope
// 2. Completing tool_result blocks from { type: "user" } events
// 3. Tracking token usage from "result" events

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
 * For Claude, the transformation is thin:
 * - "assistant" events: extract the content blocks array directly
 * - "user" events: extract tool_result blocks to complete tool pairs
 * - "result" events: capture token usage and error status
 * - All other events: ignored for persistence (forwarded raw for streaming)
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
