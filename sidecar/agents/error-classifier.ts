// sidecar/agents/error-classifier.ts
// Pure error classification function. Converts opaque error objects
// into machine-readable categories so the frontend can render
// category-specific UI (auth → "Log in", rate_limit → "Retry", etc.).

import { type ErrorCategory } from "../protocol";

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
}

/**
 * Classifies an error into a machine-readable category.
 *
 * Priority order matters — earlier checks win when multiple keywords match.
 * e.g. "AbortError" always wins over a message that also mentions "network".
 */
export function classifyError(error: unknown): ClassifiedError {
  if (!(error instanceof Error)) {
    // Handle plain objects with a .message property (e.g. Codex SDK's
    // ThreadError { message: string } and ThreadErrorEvent { type, message }).
    // Wrap in a real Error so the keyword-matching logic below still applies.
    if (
      error !== null &&
      typeof error === "object" &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string"
    ) {
      return classifyError(new Error((error as { message: string }).message));
    }
    return { category: "internal", message: String(error) };
  }

  const msg = error.message.toLowerCase();
  const name = error.name;

  // Abort — user cancelled (highest priority, never retry)
  if (name === "AbortError" || msg.includes("aborted")) {
    return { category: "abort", message: error.message };
  }

  // Auth / billing errors — non-retryable, user action required
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("authentication") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("billing") ||
    msg.includes("subscription") ||
    msg.includes("out of credits") ||
    msg.includes("payment")
  ) {
    return { category: "auth", message: error.message };
  }

  // Rate limits — user can retry by sending another message
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("overloaded")) {
    return { category: "rate_limit", message: error.message };
  }

  // Context / size / turn limits — non-retryable, conversation can't continue as-is
  if (
    (msg.includes("context") &&
      (msg.includes("limit") || msg.includes("length") || msg.includes("exceeded"))) ||
    msg.includes("too large") ||
    msg.includes("exceeds the dimension limit") ||
    msg.includes("max turns") ||
    msg.includes("turn limit") ||
    msg.includes("max output token") ||
    msg.includes("output token limit") ||
    (msg.includes("budget") && (msg.includes("exceed") || msg.includes("limit")))
  ) {
    return { category: "context_limit", message: error.message };
  }

  // Server errors (5xx) — retryable, transient infrastructure issues
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("internal server error") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout")
  ) {
    return { category: "network", message: error.message };
  }

  // Network errors — retryable
  if (
    (name === "TypeError" && msg.includes("fetch")) ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enetunreach") ||
    msg.includes("dns")
  ) {
    return { category: "network", message: error.message };
  }

  // DB write errors (SQLite) — retryable short-term
  // "busy" requires "database" context to avoid matching API "Server is busy" errors.
  if (
    msg.includes("sqlite") ||
    msg.includes("database is locked") ||
    msg.includes("readonly") ||
    (msg.includes("busy") && msg.includes("database"))
  ) {
    return { category: "db_write", message: error.message };
  }

  // Invalid request — non-retryable
  if (msg.includes("invalid") && (msg.includes("request") || msg.includes("param"))) {
    return { category: "invalid_request", message: error.message };
  }

  // Process exit / signal termination — Claude Code subprocess crashed or was killed.
  // These come from the SDK when the child process exits non-zero or is terminated by a signal.
  if (
    msg.includes("exited with code") ||
    msg.includes("terminated by signal") ||
    msg.includes("process exited") ||
    msg.includes("killed by signal")
  ) {
    return { category: "process_exit", message: error.message };
  }

  // Fallback — unknown internal error
  return { category: "internal", message: error.message };
}

/**
 * Maps SDK stop_reason to an error category (or null if not an error).
 * "end_turn" and "stop_sequence" are normal completions.
 * "max_tokens" is a context_limit error — user needs a new session.
 * "cancelled" is handled separately in the abort path.
 */
export function classifyStopReason(
  stopReason: string | undefined
): ClassifiedError | null {
  if (!stopReason) return null;

  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return null; // Normal completion, not an error
    case "max_tokens":
      return {
        category: "context_limit",
        message: "Response truncated — output token limit reached.",
      };
    default:
      return null; // Unknown stop_reason — treat as normal
  }
}
