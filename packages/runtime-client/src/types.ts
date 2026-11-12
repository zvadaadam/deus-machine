export interface RuntimeIdentity {
  readonly host: string;
  readonly account: string;
  /** Opaque authorization identity, never a bearer token. */
  readonly grant: string;
}

export interface RuntimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void
  ): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type RuntimeState = "offline" | "connecting" | "online" | "revoked" | "disposed";
export type RuntimeFailureKind = "unavailable" | "unknown-outcome" | "rejected" | "disposed";

export class RuntimeError extends Error {
  constructor(
    readonly kind: RuntimeFailureKind,
    message: string
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export type QueryRequestInterceptor = (
  resource: string,
  params?: Record<string, unknown>
) => Promise<unknown> | null;
export type ToolResponseInterceptor = (
  requestId: string,
  result: unknown,
  error: string | undefined
) => boolean;
export type EventCallback = (event: string, data: unknown) => void;
export type SnapshotCallback = (data: unknown) => void;
export type DeltaCallback = (upserted?: unknown[], removed?: string[], cursor?: number) => void;
/** One event of a stream. `seq` is set on a resumable stream's events. */
export type StreamCallback = (data: unknown, seq: number | undefined) => void;
export interface ListenOptions {
  /** The last seq this listener saw, asked at each (re)subscribe so the host sends what followed. */
  after?: () => number | undefined;
  /** The host cannot say what was missed since `after`: read the resource again. */
  onReset?: (seq: number) => void;
  /** The host refused the subscription. It is not retried. */
  onRefused?: (error: RuntimeError) => void;
}
export type CommandResult = {
  accepted: boolean;
  commandId?: string;
  error?: string;
  [key: string]: unknown;
};
/** The q:mutate_result payload, including delegated route error metadata. */
export interface MutateResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
  details?: unknown;
}

export interface RuntimePorts {
  /**
   * Resolves fresh transport addresses, always for this client's bound host.
   * Rejecting with a `rejected` RuntimeError ends the runtime as `revoked`
   * instead of retrying; any other failure reconnects with backoff.
   */
  open: () => RuntimeSocket | Promise<RuntimeSocket>;
  authenticate?: () => Record<string, unknown>;
  onAuthFailure?: () => void;
  request?: QueryRequestInterceptor;
  toolResponse?: ToolResponseInterceptor;
  timeoutMs?: number;
  /** Correlated ping/pong probes detect silent or one-way failures. Default: 30s. */
  heartbeatIntervalMs?: number;
  /** Time to wait for the probe's pong. Default: 10s. Interval 0 disables probes. */
  heartbeatTimeoutMs?: number;
  retryMs?: number;
  random?: () => number;
}
