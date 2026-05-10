// packages/pencil/src/lib/iframe-rpc.ts
//
// Backend → iframe editor request-response bridge.
//
// Flow:
//   1. requestFromIframe(method, payload) is called server-side.
//   2. We assign an internal id, register a Promise resolver, and
//      broadcast an SSE "ipc-request" event with {id, method, payload}.
//   3. parent.html (browser) receives, forwards to the iframe via
//      window.postMessage.
//   4. The editor's IPCHost dispatches to its registered handler, which
//      returns a value. IPCHost emits a response via postMessage.
//   5. parent.html catches that response and POSTs it back to /ipc-response.
//   6. router.ts calls completeIframeRequest(id, response) which resolves
//      the Promise from step 2.
//
// Used both by the TransportServer (bridging the bundled MCP binary's
// tool_request to the editor) and any future internal callers.

import { randomUUID } from "node:crypto";
import { broadcastEvent } from "./ops.ts";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: string;
  startedAt: number;
}

const pending = new Map<string, PendingRequest>();
const DEFAULT_TIMEOUT_MS = 60_000;

export interface IframeReply {
  id: string;
  type: "response";
  method: string;
  payload?: unknown;
  error?: { code: string; message: string; stack?: string };
}

/** Send a request to the iframe editor and resolve with the editor's
 *  response. Rejects with TIMEOUT if the editor doesn't reply in time
 *  or if the iframe isn't connected. */
export function requestFromIframe(
  method: string,
  payload?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `host-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`iframe-rpc: ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout, method, startedAt: Date.now() });

    broadcastEvent("ipc-request", {
      id,
      type: "request",
      method,
      payload: normalizeIframePayload(method, payload),
    });
  });
}

function normalizeIframePayload(method: string, payload: unknown): unknown {
  if (method !== "batch-design" || typeof payload !== "object" || payload === null) {
    return payload;
  }
  const data = payload as Record<string, unknown>;
  if (typeof data.input === "string" || typeof data.operations !== "string") {
    return payload;
  }
  return {
    ...data,
    input: data.operations,
  };
}

/** Called by /ipc-response when the iframe replies. */
export function completeIframeRequest(reply: IframeReply): boolean {
  const entry = pending.get(reply.id);
  if (!entry) return false;
  pending.delete(reply.id);
  clearTimeout(entry.timeout);
  if (reply.error) {
    entry.reject(new Error(`${reply.error.code}: ${reply.error.message}`));
  } else {
    entry.resolve(reply.payload);
  }
  return true;
}

export function pendingRequestCount(): number {
  return pending.size;
}
