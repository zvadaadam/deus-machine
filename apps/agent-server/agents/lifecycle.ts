// agent-server/agents/lifecycle.ts
// Error classification and query lifecycle reporting helpers.

import { EventBroadcaster } from "../event-broadcaster";
import type { AgentHarness, ErrorCategory } from "../protocol";

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
}

interface ErrorMatchContext {
  name: string;
  msg: string;
}

type ErrorRule = {
  category: ErrorCategory;
  matches: (ctx: ErrorMatchContext) => boolean;
};

const ERROR_RULES: ErrorRule[] = [
  {
    category: "abort",
    matches: ({ name, msg }) => name === "AbortError" || msg.includes("aborted"),
  },
  {
    category: "auth",
    matches: ({ msg }) =>
      includesAny(msg, [
        "401",
        "403",
        "unauthorized",
        "authentication",
        "invalid api key",
        "invalid x-api-key",
        "billing",
        "subscription",
        "out of credits",
        "payment",
      ]),
  },
  {
    category: "rate_limit",
    matches: ({ msg }) => includesAny(msg, ["429", "rate limit", "overloaded"]),
  },
  {
    category: "context_limit",
    matches: ({ msg }) =>
      (msg.includes("context") && includesAny(msg, ["limit", "length", "exceeded"])) ||
      includesAny(msg, [
        "too large",
        "exceeds the dimension limit",
        "max turns",
        "turn limit",
        "max output token",
        "output token limit",
      ]) ||
      (msg.includes("budget") && includesAny(msg, ["exceed", "limit"])),
  },
  {
    category: "network",
    matches: ({ msg }) =>
      includesAny(msg, [
        "500",
        "502",
        "503",
        "internal server error",
        "service unavailable",
        "gateway timeout",
      ]),
  },
  {
    category: "network",
    matches: ({ name, msg }) =>
      (name === "TypeError" && msg.includes("fetch")) ||
      includesAny(msg, ["econnrefused", "etimedout", "enetunreach", "dns"]),
  },
  {
    category: "db_write",
    matches: ({ msg }) =>
      msg.includes("sqlite") ||
      msg.includes("database is locked") ||
      msg.includes("readonly") ||
      (msg.includes("busy") && msg.includes("database")),
  },
  {
    category: "invalid_request",
    matches: ({ msg }) =>
      msg.includes("invalid") && (msg.includes("request") || msg.includes("param")),
  },
  {
    category: "process_exit",
    matches: ({ msg }) =>
      includesAny(msg, [
        "exited with code",
        "terminated by signal",
        "process exited",
        "killed by signal",
      ]),
  },
];

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
  const rule = ERROR_RULES.find((candidate) => candidate.matches({ name, msg }));
  if (rule) return { category: rule.category, message: error.message };

  return { category: "internal", message: error.message };
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

export function classifyStopReason(stopReason: string | undefined): ClassifiedError | null {
  if (!stopReason) return null;

  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return null;
    case "max_tokens":
      return {
        category: "context_limit",
        message: "Response truncated — output token limit reached.",
      };
    default:
      return null;
  }
}

/**
 * Emits the canonical cancellation sequence. The backend persists the
 * cancelled message and session status from these events.
 */
export function persistCancellation(sessionId: string, agentHarness: AgentHarness): void {
  EventBroadcaster.emitSessionCancelled(sessionId, agentHarness);
  EventBroadcaster.emitMessageCancelled(sessionId, agentHarness);
}

/**
 * Emits a canonical session.error. `enrichMessage` lets providers append
 * context without changing the classifier.
 */
export function notifyAndRecordError(
  sessionId: string,
  agentHarness: AgentHarness,
  classified: ClassifiedError,
  enrichMessage?: (classified: ClassifiedError) => string
): void {
  const errorMessage = enrichMessage ? enrichMessage(classified) : classified.message;

  EventBroadcaster.emitSessionError(
    sessionId,
    agentHarness,
    errorMessage,
    classified.category as ErrorCategory
  );
}

export function handleCancellation(
  sessionId: string,
  agentHarness: AgentHarness,
  wasCancelled: boolean
): boolean {
  if (!wasCancelled) return false;
  persistCancellation(sessionId, agentHarness);
  return true;
}

export function handleQueryError(
  sessionId: string,
  agentHarness: AgentHarness,
  error: unknown,
  enrichMessage?: (classified: ClassifiedError) => string
): void {
  const classified = classifyError(error);
  notifyAndRecordError(sessionId, agentHarness, classified, enrichMessage);
}
