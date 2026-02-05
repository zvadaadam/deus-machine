import { randomUUID } from "crypto";

/**
 * Test data builders for sidecar-v2 JSON-RPC protocol messages.
 * Uses the builder pattern with overrides for concise, intent-clear tests.
 */

// ============================================================================
// Frontend → Sidecar requests
// ============================================================================

export function buildQueryRequest(overrides?: Record<string, any>) {
  return {
    type: "query",
    id: `sess_${randomUUID().slice(0, 8)}`,
    agentType: "claude" as const,
    prompt: "Hello, Claude",
    options: {
      cwd: "/tmp/test-workspace",
      model: "sonnet",
      turnId: `turn_${randomUUID().slice(0, 8)}`,
      permissionMode: "default",
      ...overrides?.options,
    },
    ...overrides,
  };
}

export function buildCancelRequest(overrides?: Record<string, any>) {
  return {
    type: "cancel",
    id: `sess_${randomUUID().slice(0, 8)}`,
    agentType: "claude" as const,
    ...overrides,
  };
}

export function buildClaudeAuthRequest(overrides?: Record<string, any>) {
  return {
    type: "claude_auth",
    id: `sess_${randomUUID().slice(0, 8)}`,
    agentType: "claude" as const,
    options: {
      cwd: "/tmp/test-workspace",
      ...overrides?.options,
    },
    ...overrides,
  };
}

export function buildWorkspaceInitRequest(overrides?: Record<string, any>) {
  return {
    type: "workspace_init",
    id: `sess_${randomUUID().slice(0, 8)}`,
    agentType: "claude" as const,
    options: {
      cwd: "/tmp/test-workspace",
      ...overrides?.options,
    },
    ...overrides,
  };
}

export function buildContextUsageRequest(overrides?: Record<string, any>) {
  return {
    type: "context_usage",
    id: `sess_${randomUUID().slice(0, 8)}`,
    agentType: "claude" as const,
    options: {
      cwd: "/tmp/test-workspace",
      claudeSessionId: `claude_${randomUUID().slice(0, 8)}`,
      ...overrides?.options,
    },
    ...overrides,
  };
}

export function buildUpdatePermissionModeRequest(overrides?: Record<string, any>) {
  return {
    type: "update_permission_mode",
    id: `sess_${randomUUID().slice(0, 8)}`,
    agentType: "claude" as const,
    permissionMode: "plan",
    ...overrides,
  };
}

export function buildResetGeneratorRequest(overrides?: Record<string, any>) {
  return {
    type: "reset_generator",
    id: `sess_${randomUUID().slice(0, 8)}`,
    agentType: "claude" as const,
    ...overrides,
  };
}

// ============================================================================
// Sidecar → Frontend notifications / responses
// ============================================================================

export function buildMessageResponse(overrides?: Record<string, any>) {
  return {
    id: `sess_${randomUUID().slice(0, 8)}`,
    type: "message" as const,
    agentType: "claude" as const,
    data: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Test response" }],
      },
    },
    ...overrides,
  };
}

export function buildErrorResponse(overrides?: Record<string, any>) {
  return {
    id: `sess_${randomUUID().slice(0, 8)}`,
    type: "error" as const,
    error: "Test error",
    agentType: "claude" as const,
    ...overrides,
  };
}

export function buildEnterPlanModeNotification(overrides?: Record<string, any>) {
  return {
    type: "enter_plan_mode_notification" as const,
    id: `sess_${randomUUID().slice(0, 8)}`,
    agentType: "claude" as const,
    ...overrides,
  };
}

// ============================================================================
// JSON-RPC helpers
// ============================================================================

let jsonRpcIdCounter = 1;

export function buildJsonRpcNotification(method: string, params: unknown) {
  return {
    jsonrpc: "2.0",
    method,
    params,
  };
}

export function buildJsonRpcRequest(method: string, params: unknown) {
  return {
    jsonrpc: "2.0",
    id: jsonRpcIdCounter++,
    method,
    params,
  };
}

export function buildJsonRpcResponse(id: number, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function buildJsonRpcErrorResponse(id: number, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

/** Serialize JSON-RPC messages as newline-delimited JSON */
export function toNDJSON(...messages: Record<string, any>[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
}

/** Reset the JSON-RPC ID counter (use in beforeEach) */
export function resetJsonRpcIdCounter(): void {
  jsonRpcIdCounter = 1;
}
