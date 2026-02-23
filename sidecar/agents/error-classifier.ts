// sidecar/agents/error-classifier.ts
// Pure error classification function inspired by Codex App Server's
// CodexErrorInfo enum + will_retry pattern. Converts opaque error objects
// into machine-readable categories with retry hints.

import { type ErrorCategory } from "../protocol";

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  willRetry: boolean;
  retryAfterMs?: number;
}

/**
 * Classifies an error into a machine-readable category with retry metadata.
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
    return { category: "internal", message: String(error), willRetry: false };
  }

  const msg = error.message.toLowerCase();
  const name = error.name;

  // Abort — user cancelled (highest priority, never retry)
  if (name === "AbortError" || msg.includes("aborted")) {
    return { category: "abort", message: error.message, willRetry: false };
  }

  // Auth errors — non-retryable, user action required
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("authentication") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid x-api-key")
  ) {
    return { category: "auth", message: error.message, willRetry: false };
  }

  // Rate limits — retryable with backoff
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("overloaded")) {
    const retryMatch = error.message.match(/retry.after.?(\d+)/i);
    return {
      category: "rate_limit",
      message: error.message,
      willRetry: true,
      retryAfterMs: retryMatch ? parseInt(retryMatch[1]) * 1000 : 5000,
    };
  }

  // Context limits — non-retryable, conversation too long
  if (
    msg.includes("context") &&
    (msg.includes("limit") || msg.includes("length") || msg.includes("exceeded"))
  ) {
    return { category: "context_limit", message: error.message, willRetry: false };
  }

  // Network errors — retryable
  if (
    (name === "TypeError" && msg.includes("fetch")) ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enetunreach") ||
    msg.includes("dns")
  ) {
    return { category: "network", message: error.message, willRetry: true, retryAfterMs: 3000 };
  }

  // DB write errors (SQLite) — retryable short-term
  // "busy" requires "database" context to avoid matching API "Server is busy" errors.
  if (
    msg.includes("sqlite") ||
    msg.includes("database is locked") ||
    msg.includes("readonly") ||
    (msg.includes("busy") && msg.includes("database"))
  ) {
    return { category: "db_write", message: error.message, willRetry: true, retryAfterMs: 500 };
  }

  // Invalid request — non-retryable
  if (msg.includes("invalid") && (msg.includes("request") || msg.includes("param"))) {
    return { category: "invalid_request", message: error.message, willRetry: false };
  }

  // Fallback — unknown internal error
  return { category: "internal", message: error.message, willRetry: false };
}
