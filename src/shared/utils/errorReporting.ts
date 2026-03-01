import * as Sentry from "@sentry/react";

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

  return normalized;
}
