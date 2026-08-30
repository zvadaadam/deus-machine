// apps/web/src/features/session/cloud/cloudSessionSocket.ts
// Browser copy of the backend's `agent/cloud/session-socket.ts`.
//
// Path B, slice 2: the browser opens an agnt session channel DIRECTLY, with no
// Mac backend in the middle. The frame protocol is the same small one the
// backend speaks — JSON events in, JSON commands out, "ping"/"pong" keep-alive,
// a `session.snapshot` on every (re)connect — so this is the backend socket
// verbatim, with two browser-shaped changes:
//
//   1. the WebSocket is created through an injected `createWs` factory (default:
//      the global `WebSocket`), so a test can drive the whole engine against a
//      mock without a network; and
//   2. readyState is compared against the standard numeric constants rather than
//      `WebSocket.CONNECTING`/`.OPEN`, so a mock never has to re-declare the
//      global's statics.
//
// Everything else — ping/pong, exponential backoff, the handshake deadline, the
// bounded `ready()` verdict, `onFrame`/`onOpen`/`onDown` — is unchanged.

import { API_VERSION } from "@deus-hq/api";

/** The event a "message" listener receives — the sliver the socket reads. */
export interface WebSocketLikeMessage {
  readonly data?: unknown;
}

/**
 * The sliver of the DOM `WebSocket` this socket uses, so a mock can stand in.
 * The real `WebSocket` is structurally assignable to it; the injected factory
 * returns one of these instead of a hard reference to the global.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: WebSocketLikeMessage) => void
  ): void;
}

/** Standard `WebSocket.readyState` values — the same for the global and a mock. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export interface CloudSessionSocketOptions {
  baseUrl: string;
  /** agnt session id (provider id, not the deus session id). */
  providerSessionId: string;
  /** Session-scoped JWT minted via the dashboard token exchange. */
  token: string;
  onFrame: (frame: Record<string, unknown>) => void;
  onOpen?: () => void;
  /** Terminal close: retries exhausted or close() called. */
  onDown?: (reason: string) => void;
  /** Injected WebSocket factory — defaults to the global `WebSocket`. */
  createWs?: (url: string) => WebSocketLike;
}

export interface CloudSessionSocket {
  /** Resolves once the socket is OPEN (rejects on terminal failure). */
  ready(): Promise<void>;
  send(frame: Record<string, unknown>): void;
  isOpen(): boolean;
  close(): void;
}

const PING_INTERVAL_MS = 30_000;
const MAX_RETRIES = 8;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** A stalled WS handshake (TCP up, no open/close event) fires neither
 *  handler — without a deadline the attempt hangs instead of retrying. */
const HANDSHAKE_DEADLINE_MS = 10_000;
/** Bound on ready(): callers need a verdict, not a background retry loop — the
 *  socket keeps retrying after this rejects. */
const READY_DEADLINE_MS = 30_000;

export function connectCloudSessionSocket(options: CloudSessionSocketOptions): CloudSessionSocket {
  const { baseUrl, providerSessionId, token } = options;
  const createWs = options.createWs ?? ((url: string) => new WebSocket(url));
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/sessions/${providerSessionId}/ws?v=${API_VERSION}&token=${encodeURIComponent(token)}`;

  let ws: WebSocketLike | null = null;
  let closed = false;
  let attempt = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const stopPing = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };

  const open = () => {
    if (closed) return;
    ws = createWs(wsUrl);
    const socket = ws;

    // Stalled handshake → force-close so the close handler owns retry policy.
    const handshakeTimer = setTimeout(() => {
      if (socket.readyState === WS_CONNECTING) socket.close();
    }, HANDSHAKE_DEADLINE_MS);

    ws.addEventListener("open", () => {
      clearTimeout(handshakeTimer);
      attempt = 0;
      stopPing();
      pingTimer = setInterval(() => {
        if (ws?.readyState === WS_OPEN) ws.send("ping");
      }, PING_INTERVAL_MS);
      readyResolve?.();
      readyResolve = null;
      options.onOpen?.();
    });

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw || raw === "pong") return;
      try {
        options.onFrame(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        console.warn(`[CloudDirectSocket] unparseable frame for ${providerSessionId}`);
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(handshakeTimer);
      stopPing();
      if (closed) return;
      if (attempt >= MAX_RETRIES) {
        closed = true;
        const reason = `session socket down after ${MAX_RETRIES} retries`;
        readyReject?.(new Error(reason));
        readyReject = null;
        options.onDown?.(reason);
        return;
      }
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      attempt += 1;
      setTimeout(open, delay);
    });

    // 'close' always follows 'error' — the close handler owns retry policy.
    ws.addEventListener("error", () => {});
  };

  open();

  // Callers awaiting ready() need a bounded verdict even while the retry loop
  // keeps working in the background (a later reconnect still delivers events).
  const readyWithDeadline = Promise.race([
    readyPromise,
    new Promise<void>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error("cloud session socket connect timed out")),
        READY_DEADLINE_MS
      );
      void readyPromise.finally(() => clearTimeout(t)).catch(() => {});
    }),
  ]);
  // A deadline rejection with no other listener must not crash the tab.
  readyWithDeadline.catch(() => {});

  return {
    ready: () => readyWithDeadline,
    send(frame) {
      if (!ws || ws.readyState !== WS_OPEN) {
        throw new Error("Cloud session socket is not connected");
      }
      ws.send(JSON.stringify(frame));
    },
    isOpen: () => ws?.readyState === WS_OPEN,
    close() {
      closed = true;
      stopPing();
      readyReject?.(new Error("session socket closed"));
      readyReject = null;
      ws?.close();
      ws = null;
    },
  };
}
