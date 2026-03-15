// sidecar/agents/query-completion.ts
// Shared helpers for the post-loop patterns that every agent handler
// uses at the edges of its streaming loop (cancellation and error handling).
//
// These were duplicated 4x (cancellation) and 2x (error handling) across
// claude-handler.ts and codex-handler.ts. Extracted here so future agents
// (Gemini, etc.) get them for free.

import { persistCancellation, notifyAndRecordError } from "./query-lifecycle";
import { classifyError, type ClassifiedError } from "./error-classifier";
import type { AgentType } from "../protocol";

/**
 * Handles the cancellation post-loop pattern.
 *
 * If `wasCancelled` is true, persists the cancellation event and returns
 * true to signal the caller should return early. Otherwise returns false.
 *
 * Replaces the duplicated pattern:
 *   if (session.cancelledByUser) {
 *     persistCancellation(sessionId, agentType, model);
 *     return;
 *   }
 */
export function handleCancellation(
  sessionId: string,
  agentType: AgentType,
  model: string,
  wasCancelled: boolean
): boolean {
  if (!wasCancelled) return false;
  persistCancellation(sessionId, agentType, model);
  return true; // signals early exit
}

/**
 * Handles the error post-loop pattern.
 *
 * Classifies the error and calls notifyAndRecordError with optional
 * handler-specific message enrichment.
 *
 * Replaces the duplicated pattern:
 *   const classified = classifyError(error);
 *   notifyAndRecordError(sessionId, agentType, classified, enrichFn);
 */
export function handleQueryError(
  sessionId: string,
  agentType: AgentType,
  error: unknown,
  enrichMessage?: (classified: ClassifiedError) => string
): void {
  const classified = classifyError(error);
  notifyAndRecordError(sessionId, agentType, classified, enrichMessage);
}
