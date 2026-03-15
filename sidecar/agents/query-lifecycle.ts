// sidecar/agents/query-lifecycle.ts
// Shared query lifecycle side effects: cancellation notification and error
// reporting. These are the state-transition operations that every agent
// handler needs at the edges of its streaming loop (cancel, error, cleanup).
//
// The agent-server is stateless — no DB writes. The backend persists session
// status changes by consuming canonical events via the WS tunnel.

import { EventBroadcaster } from "../event-broadcaster";
import type { ClassifiedError } from "./error-classifier";
import type { AgentType } from "../protocol";
import type { ErrorCategory } from "../../shared/enums";

// ============================================================================
// Cancellation Notification
// ============================================================================

/**
 * Notifies all connected tunnels of a cancellation event and emits canonical
 * session lifecycle events. The backend handles DB persistence (saving the
 * cancelled message and updating session status to idle).
 *
 * This identical sequence was duplicated 4 times across both handlers:
 * - claude-handler.ts post-loop cancel path
 * - claude-handler.ts catch cancel path
 * - codex-handler.ts post-loop abort path
 * - codex-handler.ts catch abort path
 */
export function persistCancellation(sessionId: string, agentType: AgentType, _model: string): void {
  EventBroadcaster.sendMessage({
    id: sessionId,
    type: "message",
    agentType,
    data: { type: "cancelled" },
  });

  // Emit canonical session lifecycle events — backend handles DB writes
  EventBroadcaster.emitSessionCancelled(sessionId, agentType);
  EventBroadcaster.emitMessageCancelled(sessionId, agentType);
}

// ============================================================================
// Error Reporting
// ============================================================================

/**
 * Reports a classified error to the frontend and emits canonical session.error.
 * The backend handles persisting the error status to the DB.
 *
 * The optional `enrichMessage` callback allows handler-specific enrichment
 * without modifying this shared function (Open/Closed). Claude uses it
 * to append process_exit diagnostics (resume state, message count, etc.).
 * Codex passes nothing and gets the classified message as-is.
 */
export function notifyAndRecordError(
  sessionId: string,
  agentType: AgentType,
  classified: ClassifiedError,
  enrichMessage?: (classified: ClassifiedError) => string
): void {
  const errorMessage = enrichMessage ? enrichMessage(classified) : classified.message;

  EventBroadcaster.sendError({
    id: sessionId,
    type: "error",
    error: errorMessage,
    agentType,
    category: classified.category,
  });

  // Emit canonical session.error event — backend handles DB status update
  EventBroadcaster.emitSessionError(
    sessionId,
    agentType,
    errorMessage,
    classified.category as ErrorCategory
  );
}
