// agent-server/messages/claude-events.ts
// Raw Claude Code SDK event types.
//
// These represent the actual events emitted by @anthropic-ai/claude-agent-sdk.
// The agent-server receives them from the SDK and the claude-adapter transforms
// them into unified Parts.

// ---------------------------------------------------------------------------
// Content blocks (inside assistant messages and stream events)
// ---------------------------------------------------------------------------

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeThinkingBlock;

// ---------------------------------------------------------------------------
// Tool result (inside user events)
// ---------------------------------------------------------------------------

export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | { type: "text"; text: string }[];
  is_error?: boolean;
}

// ---------------------------------------------------------------------------
// Stream deltas
// ---------------------------------------------------------------------------

export type ClaudeDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "signature_delta"; signature: string };

// ---------------------------------------------------------------------------
// Raw stream events (inside stream_event wrapper)
// ---------------------------------------------------------------------------

export type ClaudeRawStreamEvent =
  | { type: "content_block_start"; index: number; content_block: ClaudeContentBlock }
  | { type: "content_block_delta"; index: number; delta: ClaudeDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_start"; message: { usage?: ClaudeUsage } }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: { output_tokens: number } }
  | { type: "message_stop" };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ---------------------------------------------------------------------------
// Top-level SDK events
// ---------------------------------------------------------------------------

export type ClaudeSystemEvent =
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "system"; subtype: "status"; status: string | null; session_id: string }
  | {
      type: "system";
      subtype: "compact_boundary";
      compact_metadata: { trigger: "manual" | "auto"; pre_tokens: number };
      session_id: string;
    };

export interface ClaudeUserEvent {
  type: "user";
  message: {
    id: string;
    role: "user";
    content: string | (ClaudeContentBlock | ClaudeToolResultBlock)[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    content: ClaudeContentBlock[];
    usage?: ClaudeUsage;
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface ClaudeStreamEvent {
  type: "stream_event";
  event: ClaudeRawStreamEvent;
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  session_id?: string;
  cost_usd?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  usage?: ClaudeUsage;
}

export type ClaudeCodeEvent =
  | ClaudeSystemEvent
  | ClaudeUserEvent
  | ClaudeAssistantEvent
  | ClaudeStreamEvent
  | ClaudeResultEvent;
