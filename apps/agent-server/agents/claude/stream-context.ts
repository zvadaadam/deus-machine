// agent-server/agents/claude/stream-context.ts
// Mutable state accumulated during the for-await streaming loop.

/**
 * Mutable context accumulated during the for-await streaming loop.
 * Each field has a single writer and clear lifecycle:
 *
 * - querySucceeded:  set once when result/success is received
 * - stopReasonError: set once when classifyStopReason detects an error
 * - messageCount:    incremented per SDK message
 * - lastResultError: set when result/error_during_execution is received
 * - firstMessageTime: timestamp of first SDK message (ms), null until set
 */
export interface StreamContext {
  querySucceeded: boolean;
  stopReasonError: boolean;
  messageCount: number;
  lastResultError: string | null;
  firstMessageTime: number | null;
}

export function createStreamContext(): StreamContext {
  return {
    querySucceeded: false,
    stopReasonError: false,
    messageCount: 0,
    lastResultError: null,
    firstMessageTime: null,
  };
}
