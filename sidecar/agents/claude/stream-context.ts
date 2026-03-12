// sidecar/agents/claude/stream-context.ts
// Tracks mutable state accumulated during a streaming loop and resolves
// the final outcome. Replaces scattered boolean flags and ~100 lines
// of if/return chains in processWithGenerator's post-loop + catch blocks.

import { match } from "ts-pattern";
import { getErrorMessage } from "../../../shared/lib/errors";
import { classifyError } from "../error-classifier";
import { persistCancellation, notifyAndRecordError } from "../query-lifecycle";
import { updateSessionStatus } from "../../db/session-writer";
import { getSession, type SessionState } from "./claude-session";

// ============================================================================
// StreamContext — replaces 5 scattered flags
// ============================================================================

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

// ============================================================================
// StreamOutcome — discriminated union for post-loop/catch resolution
// ============================================================================

export type StreamOutcome =
  | { type: "cancelled" }
  | { type: "completed"; stopReasonError: boolean }
  | { type: "post_success_exit"; stopReasonError: boolean }
  | { type: "genuine_error"; error: unknown; ownsSession: boolean };

/**
 * Resolves the stream outcome from the post-loop or catch context.
 *
 * This is a pure classification step — no side effects. Side effects
 * are performed by executeOutcome() below.
 *
 * @param ctx       - accumulated stream context
 * @param session   - session state (for cancelledByUser flag)
 * @param error     - if called from catch, the thrown error; null for post-loop
 * @param sessionId - for reference-identity ownership check
 */
export function resolveStreamOutcome(
  ctx: StreamContext,
  session: SessionState,
  error: unknown | null,
  sessionId: string
): StreamOutcome {
  // Cancel check — applies to both post-loop and catch paths.
  // Cancel takes priority over all other outcomes.
  if (session.cancelledByUser) {
    return { type: "cancelled" };
  }

  // Post-loop path (error === null): normal completion
  if (error === null) {
    return { type: "completed", stopReasonError: ctx.stopReasonError };
  }

  // Catch path: post-success SIGINT — process exited after query completed.
  // The CLI binary shuts down between turns, and the SDK reports any
  // signal-based exit as an error. This is expected cleanup, not failure.
  if (ctx.querySucceeded) {
    return { type: "post_success_exit", stopReasonError: ctx.stopReasonError };
  }

  // Catch path: genuine error — check if this generator still owns the session.
  // A rapid re-query can replace the session before the catch runs.
  const currentSession = getSession(sessionId);
  const ownsSession = !currentSession || currentSession === session;
  return { type: "genuine_error", error, ownsSession };
}

// ============================================================================
// executeOutcome — side effects via ts-pattern .exhaustive()
// ============================================================================

/**
 * Executes the side effects for a stream outcome.
 * Separated from resolveStreamOutcome so classification is testable as pure.
 */
export function executeOutcome(
  outcome: StreamOutcome,
  sessionId: string,
  ctx: StreamContext,
  options: { model?: string; resume?: string },
  generatorId: string
): void {
  match(outcome)
    .with({ type: "cancelled" }, () => {
      persistCancellation(sessionId, "claude", options.model || "opus");
      console.log(`[${generatorId}] Session cancelled by user: ${sessionId}`);
    })
    .with({ type: "completed" }, ({ stopReasonError }) => {
      // Normal completion — ensure session is marked idle.
      // Skip if a stop-reason error was already recorded (e.g. max_tokens).
      if (!stopReasonError) {
        updateSessionStatus(sessionId, "idle");
      }
      console.log(`[${generatorId}] Session completed: ${sessionId}`);
    })
    .with({ type: "post_success_exit" }, ({ stopReasonError }) => {
      // Process exited after successful query — expected cleanup.
      if (!stopReasonError) {
        updateSessionStatus(sessionId, "idle");
      }
      console.log(
        `[${generatorId}] Process exited after successful query (expected cleanup)`
      );
    })
    .with({ type: "genuine_error" }, ({ error, ownsSession }) => {
      const classified = classifyError(error);
      const rawErrorMsg = getErrorMessage(error);
      const errorName = error instanceof Error ? error.name : "non-Error";
      const errorStack = error instanceof Error
        ? error.stack?.split("\n").slice(0, 5).join("\n")
        : "no stack";
      // Extract any extra properties the SDK may attach (cause, code, exitCode, signal, etc.)
      const extraProps = error instanceof Error
        ? Object.getOwnPropertyNames(error)
            .filter((k) => !["message", "stack", "name"].includes(k))
            .map((k) => `${k}=${JSON.stringify((error as any)[k])}`)
            .join(" ")
        : "";

      console.error(
        `[${generatorId}] Error in Claude query [${classified.category}]:`,
        classified.message
      );
      console.error(
        `[${generatorId}] Error details:`,
        `name=${errorName}`,
        `wasResume=${!!options.resume}`,
        `resumeId=${options.resume ?? "none"}`,
        `querySucceeded=${ctx.querySucceeded}`,
        `messageCount=${ctx.messageCount}`,
        extraProps ? `extraProps={${extraProps}}` : "extraProps={}",
      );
      console.error(`[${generatorId}] Stack (top 5):\n${errorStack}`);

      if (ownsSession) {
        // Enrich process_exit errors with diagnostic context that would
        // otherwise only appear in /tmp/opendevs-*.log. For other categories
        // (auth, rate_limit, etc.) the SDK message is already descriptive.
        notifyAndRecordError(sessionId, "claude", classified, (c) => {
          if (c.category !== "process_exit") return c.message;
          const parts: string[] = [c.message];
          if (options.resume) parts.push("(resumed session)");
          if (ctx.messageCount > 0) {
            parts.push(`after ${ctx.messageCount} message${ctx.messageCount !== 1 ? "s" : ""}`);
          } else {
            parts.push("before receiving any messages");
          }
          if (ctx.lastResultError) parts.push(`— ${ctx.lastResultError}`);
          if (extraProps) parts.push(`[${extraProps}]`);
          return parts.join(" ");
        });
      }
    })
    .exhaustive();
}
