import { randomUUID } from "crypto";

/**
 * Test data builders for agent-server JSON-RPC protocol messages.
 * Uses the builder pattern with overrides for concise, intent-clear tests.
 */

// ============================================================================
// Agent-server → Frontend notifications / responses
// ============================================================================

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
