// agent-server/messages/codex-events.ts
// Codex CLI event types — a curated subset of OpenAI Codex's EventMsg union.
//
// We capture only the events needed to produce unified Parts (text, reasoning,
// tool calls, turn lifecycle, tokens). Begin/end pairs are correlated by call_id.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Text streaming
// ---------------------------------------------------------------------------

const AgentMessageDeltaEventSchema = z.object({
  type: z.literal("agent_message_delta"),
  delta: z.string(),
});

const AgentMessageEventSchema = z.object({
  type: z.literal("agent_message"),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

const AgentReasoningDeltaEventSchema = z.object({
  type: z.literal("agent_reasoning_delta"),
  delta: z.string(),
});

const AgentReasoningEventSchema = z.object({
  type: z.literal("agent_reasoning"),
  text: z.string(),
});

// ---------------------------------------------------------------------------
// Shell command execution
// ---------------------------------------------------------------------------

const ExecCommandBeginEventSchema = z.object({
  type: z.literal("exec_command_begin"),
  call_id: z.string(),
  turn_id: z.string(),
  command: z.array(z.string()),
  cwd: z.string(),
});

const ExecCommandEndEventSchema = z.object({
  type: z.literal("exec_command_end"),
  call_id: z.string(),
  turn_id: z.string(),
  command: z.array(z.string()),
  cwd: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  aggregated_output: z.string().optional(),
  exit_code: z.number(),
});

const ExecApprovalRequestEventSchema = z.object({
  type: z.literal("exec_approval_request"),
  call_id: z.string(),
  turn_id: z.string(),
  command: z.array(z.string()),
  cwd: z.string(),
  reason: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// File patches
// ---------------------------------------------------------------------------

const FileChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), content: z.string() }),
  z.object({ type: z.literal("delete"), content: z.string() }),
  z.object({
    type: z.literal("update"),
    unified_diff: z.string(),
    move_path: z.string().nullable().optional(),
  }),
]);

const PatchApplyBeginEventSchema = z.object({
  type: z.literal("patch_apply_begin"),
  call_id: z.string(),
  turn_id: z.string(),
  auto_approved: z.boolean().optional(),
  changes: z.record(FileChangeSchema),
});

const PatchApplyEndEventSchema = z.object({
  type: z.literal("patch_apply_end"),
  call_id: z.string(),
  turn_id: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  success: z.boolean(),
  changes: z.record(FileChangeSchema),
});

const ApplyPatchApprovalRequestEventSchema = z.object({
  type: z.literal("apply_patch_approval_request"),
  call_id: z.string(),
  turn_id: z.string(),
  changes: z.record(FileChangeSchema),
  reason: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// MCP tool calls
// ---------------------------------------------------------------------------

const McpInvocationSchema = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown().nullable().optional(),
});

const McpToolCallBeginEventSchema = z.object({
  type: z.literal("mcp_tool_call_begin"),
  call_id: z.string(),
  invocation: McpInvocationSchema,
});

const McpToolCallEndEventSchema = z.object({
  type: z.literal("mcp_tool_call_end"),
  call_id: z.string(),
  invocation: McpInvocationSchema,
  duration: z.string().optional(),
  result: z.union([
    z.object({ Ok: z.object({ content: z.array(z.unknown()), isError: z.boolean().optional() }) }),
    z.object({ Err: z.string() }),
  ]),
});

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

const TaskStartedEventSchema = z.object({
  type: z.literal("task_started"),
  turn_id: z.string(),
});

const TaskCompleteEventSchema = z.object({
  type: z.literal("task_complete"),
  turn_id: z.string(),
  last_agent_message: z.string().nullable().optional(),
});

const TurnAbortedEventSchema = z.object({
  type: z.literal("turn_aborted"),
  turn_id: z.string().nullable().optional(),
  reason: z.enum(["interrupted", "replaced", "review_ended"]),
});

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

const CodexTokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
});

const TokenCountEventSchema = z.object({
  type: z.literal("token_count"),
  info: z
    .object({
      total_token_usage: CodexTokenUsageSchema.optional(),
      last_token_usage: CodexTokenUsageSchema,
    })
    .nullable(),
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const SessionConfiguredEventSchema = z.object({
  type: z.literal("session_configured"),
  session_id: z.string(),
  model: z.string(),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Unified CodexEvent
// ---------------------------------------------------------------------------

export const CodexEventSchema = z.discriminatedUnion("type", [
  AgentMessageDeltaEventSchema,
  AgentMessageEventSchema,
  AgentReasoningDeltaEventSchema,
  AgentReasoningEventSchema,
  ExecCommandBeginEventSchema,
  ExecCommandEndEventSchema,
  ExecApprovalRequestEventSchema,
  PatchApplyBeginEventSchema,
  PatchApplyEndEventSchema,
  ApplyPatchApprovalRequestEventSchema,
  McpToolCallBeginEventSchema,
  McpToolCallEndEventSchema,
  TaskStartedEventSchema,
  TaskCompleteEventSchema,
  TurnAbortedEventSchema,
  TokenCountEventSchema,
  SessionConfiguredEventSchema,
  ErrorEventSchema,
]);

export type CodexEvent = z.infer<typeof CodexEventSchema>;
