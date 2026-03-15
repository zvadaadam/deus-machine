// sidecar/agents/query-lifecycle.ts
// Shared query lifecycle side effects: cancellation persistence and error
// reporting. These are the state-transition operations that every agent
// handler needs at the edges of its streaming loop (cancel, error, cleanup).
//
// Extracted from duplicate code across claude-handler.ts (2 copies) and
// codex-handler.ts (2 copies). Each handler calls these at the right point
// in its own control flow — no base class, no template method.

import { FrontendClient } from "../frontend-client";
import { saveAssistantMessage, updateSessionStatus } from "../db/session-writer";
import type { ClassifiedError } from "./error-classifier";
import type { AgentType } from "../protocol";
import type { ErrorCategory } from "../../shared/enums";

// ============================================================================
// Cancellation Persistence
// ============================================================================

/**
 * Persists a cancellation event: saves a cancelled assistant message to DB,
 * notifies the frontend, and updates session status to idle.
 *
 * This identical sequence was duplicated 4 times across both handlers:
 * - claude-handler.ts post-loop cancel path
 * - claude-handler.ts catch cancel path
 * - codex-handler.ts post-loop abort path
 * - codex-handler.ts catch abort path
 */
export function persistCancellation(sessionId: string, agentType: AgentType, model: string): void {
  const writeResult = saveAssistantMessage(
    sessionId,
    {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stop_reason: "cancelled",
    },
    model
  );

  if (!writeResult.ok) {
    console.error(
      `[persistCancellation] DB write failed for cancelled message: ${writeResult.error}`
    );
  }

  FrontendClient.sendMessage({
    id: sessionId,
    type: "message",
    agentType,
    data: { type: "cancelled" },
  });

  // Dual-write: emit canonical session.cancelled + message.cancelled events
  FrontendClient.emitSessionCancelled(sessionId, agentType);
  FrontendClient.emitMessageCancelled(sessionId, agentType);

  const statusResult = updateSessionStatus(sessionId, "idle");

  if (!statusResult.ok) {
    FrontendClient.sendError({
      id: sessionId,
      type: "error",
      error: `Session status update failed: ${statusResult.error}`,
      agentType,
      category: "db_write",
    });
  }
}

// ============================================================================
// Error Reporting
// ============================================================================

/**
 * Reports a classified error to the frontend and updates session status.
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

  FrontendClient.sendError({
    id: sessionId,
    type: "error",
    error: errorMessage,
    agentType,
    category: classified.category,
  });

  // Dual-write: emit canonical session.error event
  FrontendClient.emitSessionError(
    sessionId,
    agentType,
    errorMessage,
    classified.category as ErrorCategory
  );

  const statusResult = updateSessionStatus(sessionId, "error", errorMessage, classified.category);

  // If the status update itself fails, the session is stuck — notify frontend
  if (!statusResult.ok) {
    FrontendClient.sendError({
      id: sessionId,
      type: "error",
      error: `Session status update failed: ${statusResult.error}`,
      agentType,
      category: "db_write",
    });
  }
}
