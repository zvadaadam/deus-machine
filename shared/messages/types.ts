// shared/messages/types.ts
// Unified message and part types for the Deus Machine protocol.
//
// These types represent the canonical structure that the agent-server produces
// and the backend/frontend consume. Provider-specific SDK events (Claude, Codex)
// are transformed into these types by adapters in the agent-server.

import { z } from "zod";

// ============================================================================
// Token Usage
// ============================================================================

export const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheCreation: z
    .object({
      total: z.number(),
      ephemeral5m: z.number().optional(),
      ephemeral1h: z.number().optional(),
    })
    .optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const emptyTokenUsage: TokenUsage = { input: 0, output: 0 };

export function addTokenUsage(a: TokenUsage, b: Partial<TokenUsage>): TokenUsage {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    reasoning:
      a.reasoning != null || b.reasoning != null
        ? (a.reasoning ?? 0) + (b.reasoning ?? 0)
        : undefined,
    cacheRead:
      a.cacheRead != null || b.cacheRead != null
        ? (a.cacheRead ?? 0) + (b.cacheRead ?? 0)
        : undefined,
    cacheCreation:
      a.cacheCreation || b.cacheCreation
        ? {
            total: (a.cacheCreation?.total ?? 0) + (b.cacheCreation?.total ?? 0),
            ephemeral5m:
              a.cacheCreation?.ephemeral5m != null || b.cacheCreation?.ephemeral5m != null
                ? (a.cacheCreation?.ephemeral5m ?? 0) + (b.cacheCreation?.ephemeral5m ?? 0)
                : undefined,
            ephemeral1h:
              a.cacheCreation?.ephemeral1h != null || b.cacheCreation?.ephemeral1h != null
                ? (a.cacheCreation?.ephemeral1h ?? 0) + (b.cacheCreation?.ephemeral1h ?? 0)
                : undefined,
          }
        : undefined,
  };
}

// ============================================================================
// Finish Reason
// ============================================================================

export const FinishReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turns",
  "cancelled",
  "error",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

// ============================================================================
// Tool Kind
// ============================================================================

export const ToolKindSchema = z.enum(["read", "write", "bash", "search", "mcp", "task", "other"]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

// ============================================================================
// Tool Location
// ============================================================================

export const ToolLocationSchema = z.object({
  path: z.string(),
  range: z
    .object({
      startLine: z.number(),
      endLine: z.number().optional(),
    })
    .optional(),
});
export type ToolLocation = z.infer<typeof ToolLocationSchema>;

// ============================================================================
// Subagent Metadata
// ============================================================================

export const SubagentMetadataSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  agentId: z.string().optional(),
});
export type SubagentMetadata = z.infer<typeof SubagentMetadataSchema>;

// ============================================================================
// Tool State (Runtime 4-state model)
// ============================================================================

export const PendingToolStateSchema = z.object({
  status: z.literal("PENDING"),
  partialInput: z.string(),
});
export type PendingToolState = z.infer<typeof PendingToolStateSchema>;

export const RunningToolStateSchema = z.object({
  status: z.literal("RUNNING"),
  input: z.unknown().optional(),
  title: z.string().optional(),
  time: z.object({ start: z.string() }),
});
export type RunningToolState = z.infer<typeof RunningToolStateSchema>;

export const TextContentSchema = z.object({ type: z.literal("text"), text: z.string() });
export const DiffContentSchema = z.object({
  type: z.literal("diff"),
  path: z.string(),
  newText: z.string(),
  oldText: z.string().optional(),
});
export const TerminalContentSchema = z.object({
  type: z.literal("terminal"),
  terminalId: z.string(),
});
export const ToolOutputContentSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  DiffContentSchema,
  TerminalContentSchema,
]);
export type TextContent = z.infer<typeof TextContentSchema>;
export type DiffContent = z.infer<typeof DiffContentSchema>;
export type ToolOutputContent = z.infer<typeof ToolOutputContentSchema>;

export const CompletedToolStateSchema = z.object({
  status: z.literal("COMPLETED"),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  content: z.array(ToolOutputContentSchema).optional(),
  time: z.object({ start: z.string(), end: z.string() }),
});
export type CompletedToolState = z.infer<typeof CompletedToolStateSchema>;

export const ErrorToolStateSchema = z.object({
  status: z.literal("ERROR"),
  input: z.unknown().optional(),
  error: z.string(),
  time: z.object({ start: z.string(), end: z.string() }),
});
export type ErrorToolState = z.infer<typeof ErrorToolStateSchema>;

export const RuntimeToolStateSchema = z.discriminatedUnion("status", [
  PendingToolStateSchema,
  RunningToolStateSchema,
  CompletedToolStateSchema,
  ErrorToolStateSchema,
]);
export type RuntimeToolState = z.infer<typeof RuntimeToolStateSchema>;

// ============================================================================
// Part Types
// ============================================================================

export const TextPartSchema = z.object({
  type: z.literal("TEXT"),
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  partIndex: z.number().optional(),
  text: z.string(),
  state: z.enum(["STREAMING", "DONE"]).optional(),
  parentToolCallId: z.string().optional(),
});
export type TextPart = z.infer<typeof TextPartSchema>;

export const ReasoningPartSchema = z.object({
  type: z.literal("REASONING"),
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  partIndex: z.number().optional(),
  text: z.string(),
  state: z.enum(["STREAMING", "DONE"]).optional(),
  time: z
    .object({
      start: z.string(),
      end: z.string().optional(),
    })
    .optional(),
  providerMetadata: z.record(z.string(), z.unknown()).optional(),
  parentToolCallId: z.string().optional(),
});
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>;

export const ToolPartSchema = z.object({
  type: z.literal("TOOL"),
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  partIndex: z.number().optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  state: RuntimeToolStateSchema,
  title: z.string().optional(),
  kind: ToolKindSchema.optional(),
  locations: z.array(ToolLocationSchema).optional(),
  subagent: SubagentMetadataSchema.optional(),
  parentToolCallId: z.string().optional(),
});
export type ToolPart = z.infer<typeof ToolPartSchema>;

export const CompactionPartSchema = z.object({
  type: z.literal("COMPACTION"),
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  partIndex: z.number().optional(),
  auto: z.boolean(),
  preTokens: z.number().optional(),
  parentToolCallId: z.string().optional(),
});
export type CompactionPart = z.infer<typeof CompactionPartSchema>;

export const PartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  CompactionPartSchema,
]);
export type Part = z.infer<typeof PartSchema>;

// ============================================================================
// Part Type Enum (for DB storage)
// ============================================================================

export const PartTypeSchema = z.enum(["TEXT", "REASONING", "TOOL", "COMPACTION"]);
export type PartType = z.infer<typeof PartTypeSchema>;
