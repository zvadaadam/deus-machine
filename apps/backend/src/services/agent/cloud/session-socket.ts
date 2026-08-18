// backend/src/services/agent/cloud/session-socket.ts
// Raw client socket for one agnt session channel.
//
// Deliberately NOT the SDK's SessionClient: deus runs its own fold
// (event-handler.ts) and needs the raw SessionRuntimeEvent frames, which the
// SDK folds away into client state. The frame protocol is small — JSON events
// in, JSON commands out, "ping"/"pong" keep-alive — and reconnect is a fetch
// of a fresh snapshot by design (the server sends `session.snapshot` on every
// connect), so a thin socket beats fighting the SDK's projection.

import { API_VERSION } from "@deus-hq/api";

export interface SessionSocketOptions {
  baseUrl: string;
  /** agnt session id (provider id, not the deus session id). */
  providerSessionId: string;
  /** Session-scoped JWT minted via createSessionToken. */
  token: string;
  onFrame: (frame: Record<string, unknown>) => void;
  onOpen?: () => void;
  /** Terminal close: retries exhausted or close() called. */
  onDown?: (reason: string) => void;
}

export interface SessionSocket {
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
/** Bound on ready(): callers (sendMessage) need a verdict, not a background
 *  retry loop — the socket keeps retrying after this rejects. */
const READY_DEADLINE_MS = 30_000;

export function connectSessionSocket(options: SessionSocketOptions): SessionSocket {
  const { baseUrl, providerSessionId, token } = options;
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/sessions/${providerSessionId}/ws?v=${API_VERSION}&token=${encodeURIComponent(token)}`;

  let ws: WebSocket | null = null;
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
    ws = new WebSocket(wsUrl);
    const socket = ws;

    // Stalled handshake → force-close so the close handler owns retry policy.
    const handshakeTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) socket.close();
    }, HANDSHAKE_DEADLINE_MS);

    ws.addEventListener("open", () => {
      clearTimeout(handshakeTimer);
      attempt = 0;
      stopPing();
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
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
        console.warn(`[CloudSocket] unparseable frame for ${providerSessionId}`);
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
  // A deadline rejection with no other listener must not crash the process.
  readyWithDeadline.catch(() => {});

  return {
    ready: () => readyWithDeadline,
    send(frame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Cloud session socket is not connected");
      }
      ws.send(JSON.stringify(frame));
    },
    isOpen: () => ws?.readyState === WebSocket.OPEN,
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
