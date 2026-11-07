/**
 * Every failure the package reports carries a stable code and, where there is
 * one, the action that fixes it. CLI and MCP surfaces print these verbatim.
 */
export type ErrorCode =
  | "invalid_argument"
  | "tool_missing"
  | "permission_denied"
  | "source_not_found"
  | "source_unavailable"
  | "bundle_exists"
  | "bundle_not_found"
  | "bundle_invalid"
  | "not_recording"
  | "start_timeout"
  | "stop_timeout"
  | "capture_failed"
  | "media_missing"
  | "media_invalid"
  | "render_failed"
  | "aborted";

export interface ErrorInfo {
  code: string;
  message: string;
  hint?: string;
}

export class ScreenStudioError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ScreenStudioError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): ErrorInfo & { details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof ScreenStudioError) {
    return { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  }
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}
