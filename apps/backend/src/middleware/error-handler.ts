import type { ErrorHandler } from "hono";
import * as Sentry from "@sentry/node";
import { AppError } from "../lib/errors";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { error: err.message, ...(err.details ? { details: err.details } : {}) },
      err.statusCode as any
    );
  }

  Sentry.captureException(err);
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
};
