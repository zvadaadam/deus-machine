export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }

  /** From a `{ error | message, details }` body a service built for a failed request. */
  static fromBody(statusCode: number, body: Record<string, unknown>): AppError {
    const message = body.error ?? body.message;
    return new AppError(
      statusCode,
      typeof message === "string" ? message : `Request failed (${statusCode})`,
      body.details
    );
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
    this.name = "ValidationError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, message, details);
    this.name = "ConflictError";
  }
}
