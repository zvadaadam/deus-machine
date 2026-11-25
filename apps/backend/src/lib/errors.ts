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

export class DifferentTurnMessageError extends ConflictError {
  constructor() {
    super("A different message was already sent as this turn. Nothing was sent.");
  }
}

/** The chat runs a turn, or waits on an answer: the send is refused, typed so a caller can tell. */
export class ChatBusyError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ChatBusyError";
  }
}

export class AgentServerDisconnectedError extends AppError {
  constructor() {
    super(503, "Agent server is disconnected");
    this.name = "AgentServerDisconnectedError";
  }
}
