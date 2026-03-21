import type { ErrorInfo } from "react";
import * as Sentry from "@sentry/react";
import { track } from "@/platform/analytics";
type ErrorContext = {
  source?: string;
  action?: string;
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string") {
      return new Error(maybeMessage);
    }
  }

  return new Error(safeStringify(error));
}

export function reportError(error: unknown, context: ErrorContext = {}): Error {
  const normalized = normalizeError(error);
  const payload = {
    ...context,
    error: {
      name: normalized.name,
      message: normalized.message,
      stack: normalized.stack,
    },
  };

  console.error("[Error]", payload);

  Sentry.captureException(normalized, {
    tags: context.tags,
    extra: { ...context.extra, source: context.source, action: context.action },
  });

  // Track errors in PostHog for reliability monitoring
  track("error_occurred", {
    source: context.source ?? "unknown",
    error_message: normalized.message.substring(0, 200),
  });

  return normalized;
}

/** Shared error handler for React error boundaries -- reports + stores component stack. */
export function createBoundaryErrorHandler(source: string) {
  return (error: unknown, info: ErrorInfo) => {
    reportError(error, {
      source,
      extra: { componentStack: info.componentStack ?? undefined },
    });
    (window as { __APP_LAST_COMPONENT_STACK__?: string }).__APP_LAST_COMPONENT_STACK__ =
      info.componentStack ?? undefined;
  };
}
