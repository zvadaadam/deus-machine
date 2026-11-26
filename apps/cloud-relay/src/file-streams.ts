// Each object owns the HTTP reads served by its registered host tunnel.
import {
  createReceiverWindow,
  decodeChunk,
  DEFAULT_WINDOW_BYTES,
  MAX_CHUNK_BYTES,
} from "../../../shared/tunnel";
import type { RelayFrame, ServerFrame } from "../../../shared/types/relay";

const MAX_STREAMS = 8;
const MAX_WAITERS = 32;
const HEAD_TIMEOUT_MS = 10_000;
// The Mac decides which of its files may leave. The relay decides which types
// its origin serves for every tenant.
const servedTypes = new Set([
  "video/mp4",
  "video/webm",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
]);
const policyHeaders = {
  "Cache-Control": "private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const fileHeaders = new Set([
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
]);

type HostReply = Extract<ServerFrame, { type: "file_head" | "file_end" }>;
type ToHost = Extract<RelayFrame, { type: "file_open" | "file_credit" | "file_cancel" }>;

export function fileNotFound(reason: string): Response {
  console.warn("relay: file request refused", reason);
  return new Response(null, { status: 404, headers: policyHeaders });
}

function responseHeaders(status: number, fields: Record<string, string>): Headers | null {
  const headers = new Headers(policyHeaders);
  for (const [name, value] of Object.entries(fields)) {
    if (fileHeaders.has(name.toLowerCase())) headers.append(name, value);
  }
  const range = headers.get("content-range");
  if (status === 416) {
    const size = /^bytes \*\/(\d+)$/.exec(range ?? "")?.[1];
    if (!size || !Number.isSafeInteger(Number(size))) return null;
    return new Headers({ ...policyHeaders, "Content-Range": `bytes */${size}` });
  }
  if (!servedTypes.has((headers.get("content-type") ?? "").toLowerCase())) return null;
  const rawLength = headers.get("content-length") ?? "";
  const length = Number(rawLength);
  if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(length)) return null;
  if (status !== 206) return range === null ? headers : null;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    end - start + 1 !== length
  )
    return null;
  if (match[3] !== "*" && (!Number.isSafeInteger(total) || end >= total)) return null;
  return headers;
}

interface FileRead {
  host: WebSocket;
  handle: string;
  range?: string;
  method: "GET" | "HEAD";
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: Response) => void;
  unlisten: () => void;
  stream?: {
    id: number;
    window: ReturnType<typeof createReceiverWindow>;
    body?: { writer: WritableStreamDefaultWriter<BufferSource>; remaining: number };
    ending: boolean;
  };
}

export class FileStreams {
  private readonly live = new Map<number, FileRead>();
  private readonly waiting = new Set<FileRead>();
  // A hibernated object can wake with its tunnel intact and old frames still in flight.
  private nextId = crypto.getRandomValues(new Uint32Array(1))[0];

  constructor(private readonly send: (host: WebSocket, frame: ToHost) => boolean) {}

  open(request: Request, handle: string, host: WebSocket): Response | Promise<Response> {
    const { method, signal } = request;
    if (method !== "GET" && method !== "HEAD") return fileNotFound("invalid method");
    if (signal.aborted) return fileNotFound("request cancelled");
    if (this.waiting.size >= MAX_WAITERS) return fileNotFound("queue full");

    return new Promise<Response>((resolve) => {
      const abort = () => this.fail(read, "request cancelled");
      const read: FileRead = {
        host,
        handle,
        method,
        range: request.headers.get("range") ?? undefined,
        timer: setTimeout(() => this.fail(read, "head timeout"), HEAD_TIMEOUT_MS),
        resolve,
        unlisten: () => signal.removeEventListener("abort", abort),
      };
      signal.addEventListener("abort", abort, { once: true });
      if (this.live.size < MAX_STREAMS) this.start(read);
      else this.waiting.add(read);
    });
  }

  private start(read: FileRead): void {
    while (this.live.has(this.nextId)) this.nextId = (this.nextId + 1) >>> 0;
    const id = this.nextId;
    this.nextId = (id + 1) >>> 0;
    read.stream = { id, window: createReceiverWindow(), ending: false };
    this.live.set(id, read);
    if (
      !this.send(read.host, {
        type: "file_open",
        streamId: id,
        handle: read.handle,
        method: read.method,
        range: read.range,
        credit: DEFAULT_WINDOW_BYTES,
      })
    ) {
      this.fail(read, "host unavailable", false);
    }
  }

  control(host: WebSocket, frame: HostReply): void {
    const read = this.live.get(frame.streamId);
    const stream = read?.stream;
    if (!read || read.host !== host || !stream || stream.ending) return;
    if (frame.type === "file_end") {
      if (frame.error !== undefined || !stream.body || stream.body.remaining !== 0) {
        this.fail(read, "incomplete file", false);
        return;
      }
      stream.ending = true;
      void stream.body.writer.close().then(
        () => this.release(read),
        () => this.fail(read, "response closed", false)
      );
      return;
    }
    if (stream.body) {
      this.fail(read, "duplicate head");
      return;
    }
    if (frame.status !== 200 && frame.status !== 206 && frame.status !== 416) {
      this.fail(read, "host refused file", false);
      return;
    }
    try {
      const headers = responseHeaders(frame.status, frame.headers);
      if (!headers) {
        this.fail(read, "invalid file metadata");
        return;
      }
      clearTimeout(read.timer);
      if (read.method === "HEAD" || frame.status === 416) {
        read.resolve(new Response(null, { status: frame.status, headers }));
        this.release(read);
        return;
      }
      const remaining = Number(headers.get("content-length"));
      const { readable, writable } = new FixedLengthStream(remaining);
      const response = new Response(readable, { status: frame.status, headers });
      const writer = writable.getWriter();
      stream.body = { writer, remaining };
      void writer.closed.catch(() => this.fail(read, "response cancelled"));
      read.resolve(response);
    } catch {
      this.fail(read, "invalid response");
    }
  }

  chunk(host: WebSocket, message: ArrayBuffer): void {
    const chunk = decodeChunk(new Uint8Array(message));
    if (!chunk.ok) return;
    const read = this.live.get(chunk.streamId);
    const stream = read?.stream;
    if (!read || read.host !== host || !stream || stream.ending) return;
    const n = chunk.payload.byteLength;
    const body = stream.body;
    // Full chunks bound the number of pending writes per window. Only the final chunk can be shorter.
    if (
      !body ||
      n === 0 ||
      n !== Math.min(MAX_CHUNK_BYTES, body.remaining) ||
      !stream.window.receive(n)
    ) {
      this.fail(read, "unexpected file bytes");
      return;
    }
    body.remaining -= n;
    // The native writer queues these in order. Its write promise settles when the response accepts the bytes.
    void body.writer.write(chunk.payload).then(
      () => {
        if (read.stream !== stream || stream.ending) return;
        if (
          stream.window.consume(n) &&
          !this.send(host, { type: "file_credit", streamId: stream.id, bytes: n })
        ) {
          this.fail(read, "host unavailable", false);
        }
      },
      () => this.fail(read, "response write failed")
    );
  }

  disconnect(host: WebSocket): void {
    // Remove this tunnel's waiters before a released slot can promote one of them.
    for (const read of this.waiting)
      if (read.host === host) this.fail(read, "host disconnected", false);
    for (const read of this.live.values())
      if (read.host === host) this.fail(read, "file route changed", host.readyState === 1);
  }

  private fail(read: FileRead, reason: string, cancel = true): void {
    const stream = read.stream;
    if (!stream && !this.waiting.has(read)) return;
    if (stream && cancel) this.send(read.host, { type: "file_cancel", streamId: stream.id });
    if (stream?.body) void stream.body.writer.abort(new Error(reason)).catch(() => {});
    else read.resolve(fileNotFound(reason));
    this.release(read);
  }

  private release(read: FileRead): void {
    clearTimeout(read.timer);
    read.unlisten();
    if (!read.stream) {
      this.waiting.delete(read);
      return;
    }
    this.live.delete(read.stream.id);
    read.stream = undefined;
    const next = this.waiting.values().next().value;
    if (next) {
      this.waiting.delete(next);
      this.start(next);
    }
  }
}
