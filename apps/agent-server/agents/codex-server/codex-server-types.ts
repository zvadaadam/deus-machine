// agent-server/agents/codex-server/codex-server-types.ts
// Minimal Codex app-server protocol types used by the local JSON-RPC transport.
//
// Codex can generate a much larger set of TS bindings via
// `codex app-server generate-ts`. We keep a curated subset here so the handler
// is insulated from app-server additions while still typing the methods and
// notifications we actually consume.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: "enabled" | "disabled" | "restricted" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: Array<never> }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface CodexThread {
  id: string;
  preview?: string;
  cwd?: string;
  turns?: CodexTurn[];
  agentNickname?: string | null;
  agentRole?: string | null;
}

export interface CodexTurn {
  id: string;
  items?: CodexThreadItem[];
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  error?: CodexTurnError | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

export interface CodexTurnError {
  message: string;
  additionalDetails?: string | null;
  codexErrorInfo?: unknown;
}

export interface CodexThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  sandbox?: CodexSandboxMode | null;
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  sessionStartSource?: string | null;
  dynamicTools?: CodexDynamicToolSpec[] | null;
  dynamic_tools?: CodexDynamicToolSpec[] | null;
}

export interface CodexThreadResumeParams extends CodexThreadStartParams {
  threadId: string;
  excludeTurns?: boolean;
}

export interface CodexThreadResponse {
  thread: CodexThread;
  model?: string;
  modelProvider?: string;
  cwd?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxPolicy;
  reasoningEffort?: CodexReasoningEffort | null;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: CodexUserInput[];
  cwd?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  sandboxPolicy?: CodexSandboxPolicy | null;
  model?: string | null;
  effort?: CodexReasoningEffort | null;
  summary?: CodexReasoningSummary | null;
  outputSchema?: JsonValue | null;
}

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface CodexDynamicToolSpec {
  namespace?: string | null;
  name: string;
  description: string;
  inputSchema: JsonValue;
  input_schema?: JsonValue;
  deferLoading?: boolean | null;
  defer_loading?: boolean | null;
}

export interface CodexDynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
}

export interface CodexDynamicToolCallResponse {
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
}

export interface CodexThreadRollbackParams {
  threadId: string;
  numTurns: number;
}

export interface CodexThreadForkParams extends CodexThreadStartParams {
  threadId: string;
  excludeTurns?: boolean;
}

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexThreadTokenUsage {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export type CodexThreadItem =
  | { type: "userMessage"; id: string; content: CodexUserInput[] }
  | { type: "hookPrompt"; id: string; fragments: unknown[] }
  | { type: "agentMessage"; id: string; text: string; phase?: string | null }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      processId?: string | null;
      status: "inProgress" | "completed" | "failed" | "declined";
      commandActions?: unknown[];
      aggregatedOutput?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: Array<{
        path: string;
        kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
        diff: string;
      }>;
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: "inProgress" | "completed" | "failed";
      arguments: JsonValue;
      result: unknown | null;
      error: { message: string } | null;
      durationMs?: number | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace: string | null;
      tool: string;
      arguments: JsonValue;
      status: "inProgress" | "completed" | "failed";
      contentItems: unknown[] | null;
      success: boolean | null;
      durationMs?: number | null;
    }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
      status: "inProgress" | "completed" | "failed";
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      reasoningEffort: CodexReasoningEffort | null;
      agentsStates: Record<string, unknown>;
    }
  | { type: "webSearch"; id: string; query: string; action: unknown | null }
  | { type: "imageView"; id: string; path: string }
  | {
      type: "imageGeneration";
      id: string;
      status: string;
      revisedPrompt: string | null;
      result: string;
      savedPath?: string;
    }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };

export type CodexAppServerNotification =
  | { method: "thread/started"; params: { thread: CodexThread } }
  | { method: "thread/status/changed"; params: { threadId: string; status: unknown } }
  | {
      method: "thread/tokenUsage/updated";
      params: { threadId: string; turnId: string; tokenUsage: CodexThreadTokenUsage };
    }
  | { method: "turn/started"; params: { threadId: string; turn: CodexTurn } }
  | { method: "turn/completed"; params: { threadId: string; turn: CodexTurn } }
  | {
      method: "item/started";
      params: { item: CodexThreadItem; threadId: string; turnId: string };
    }
  | {
      method: "item/completed";
      params: { item: CodexThreadItem; threadId: string; turnId: string };
    }
  | {
      method: "item/agentMessage/delta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "item/plan/delta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "item/reasoning/textDelta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
        contentIndex?: number;
      };
    }
  | {
      method: "item/reasoning/summaryTextDelta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
        summaryIndex?: number;
      };
    }
  | {
      method: "item/commandExecution/outputDelta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "item/fileChange/outputDelta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "item/fileChange/patchUpdated";
      params: { threadId: string; turnId: string; itemId: string; changes?: unknown };
    }
  | {
      method: "item/mcpToolCall/progress";
      params: { threadId: string; turnId: string; itemId: string; progress?: unknown };
    }
  | {
      method: "item/tool/call";
      params: CodexDynamicToolCallParams;
    }
  | {
      method: "error";
      params: { error: CodexTurnError; willRetry: boolean; threadId: string; turnId: string };
    };

export interface CodexAppServerRequestMap {
  initialize: {
    params: {
      clientInfo: { name: string; title: string | null; version: string };
      capabilities: Record<string, unknown> | null;
    };
    result: {
      userAgent: string;
      codexHome: string;
      platformFamily: string;
      platformOs: string;
    };
  };
  "thread/start": { params: CodexThreadStartParams; result: CodexThreadResponse };
  "thread/resume": { params: CodexThreadResumeParams; result: CodexThreadResponse };
  "thread/fork": { params: CodexThreadForkParams; result: CodexThreadResponse };
  "thread/rollback": { params: CodexThreadRollbackParams; result: CodexThreadResponse };
  "turn/start": { params: CodexTurnStartParams; result: CodexTurnStartResponse };
  "turn/interrupt": { params: CodexTurnInterruptParams; result: unknown };
}

export type CodexAppServerMethod = keyof CodexAppServerRequestMap;
