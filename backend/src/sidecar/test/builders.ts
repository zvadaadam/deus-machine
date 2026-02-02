import { randomUUID } from 'crypto';

/**
 * Test data builders for sidecar message types.
 * Use these instead of inline JSON to keep tests concise and intent-clear.
 */

export function buildKeepalive(overrides?: Record<string, any>) {
  return {
    type: 'keep_alive',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function buildAssistantMessage(overrides?: Record<string, any>) {
  return {
    type: 'assistant',
    message: {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Claude' }],
    },
    ...overrides,
  };
}

export function buildUserMessage(overrides?: Record<string, any>) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu_${randomUUID().slice(0, 8)}` }],
    },
    ...overrides,
  };
}

export function buildResultMessage(sessionId?: string, overrides?: Record<string, any>) {
  return {
    type: 'result',
    session_id: sessionId ?? `sess_${randomUUID().slice(0, 8)}`,
    subtype: 'success',
    ...overrides,
  };
}

export function buildControlRequest(
  toolName: string,
  input: Record<string, any> = {},
  overrides?: Record<string, any>,
) {
  return {
    type: 'control_request',
    request_id: `req_${randomUUID().slice(0, 8)}`,
    request: {
      subtype: 'can_use_tool',
      tool_name: toolName,
      input,
      ...overrides?.request,
    },
    ...overrides,
  };
}

export function buildControlResponse(requestId?: string) {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId ?? `req_${randomUUID().slice(0, 8)}`,
    },
  };
}

export function buildInitStatus(success = true) {
  return {
    type: 'init_status',
    success,
  };
}

export function buildFrontendEvent(
  event: string,
  payload: Record<string, any> = {},
) {
  return {
    type: 'frontend_event',
    event,
    payload,
  };
}

/** Serialize a message as an NDJSON line (with trailing newline). */
export function toNDJSON(...messages: Record<string, any>[]): string {
  return messages.map(m => JSON.stringify(m)).join('\n') + '\n';
}
