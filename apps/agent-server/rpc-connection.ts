// agent-server/rpc-connection.ts
// Bidirectional JSON-RPC 2.0 connection over WebSocket.
// Each JSON-RPC message is a single WS text frame.

import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
  isJSONRPCRequest,
  isJSONRPCRequests,
  isJSONRPCResponse,
  isJSONRPCResponses,
} from "json-rpc-2.0";
import type { WebSocket } from "ws";

// ============================================================================
// Transport abstraction
// ============================================================================

/**
 * Minimal interface for sending data over a connection.
 * Implemented by both net.Socket and ws.WebSocket adapters.
 */
export interface RpcTransport {
  /** Send a string payload. For sockets, appends \n. For WS, sends as text frame. */
  send(data: string): void;
  /** Returns true if the underlying connection is no longer usable. */
  isClosed(): boolean;
}

/** Wraps a ws.WebSocket as an RpcTransport (text frames). */
export function wsTransport(ws: WebSocket): RpcTransport {
  return {
    send(data: string) {
      ws.send(data);
    },
    isClosed() {
      // ws.readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
      return ws.readyState !== 1;
    },
  };
}

// ============================================================================
// JSON parsing / validation helpers
// ============================================================================

function safeJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isJsonRpcPayload(payload: unknown): boolean {
  return (
    isJSONRPCRequest(payload) ||
    isJSONRPCRequests(payload) ||
    isJSONRPCResponse(payload) ||
    isJSONRPCResponses(payload)
  );
}

// ============================================================================
// RpcConnection
// ============================================================================

export class RpcConnection {
  private transport: RpcTransport;
  private peer: JSONRPCServerAndClient;

  constructor(transport: RpcTransport) {
    this.transport = transport;

    const server = new JSONRPCServer({
      errorListener: (message, data) => {
        console.error("[RpcConnection] Server error:", message, data);
      },
    });

    const client = new JSONRPCClient((payload) => {
      if (this.transport.isClosed()) {
        return Promise.reject(new Error("Transport is closed"));
      }
      try {
        this.transport.send(JSON.stringify(payload));
        return Promise.resolve();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return Promise.reject(err);
      }
    });

    this.peer = new JSONRPCServerAndClient(server, client, {
      errorListener: (message, data) => {
        console.error("[RpcConnection] Client error:", message, data);
      },
    });
  }

  /** Register a method handler that the remote side can call */
  addMethod(name: string, method: (params: unknown) => Promise<unknown>): void {
    this.peer.addMethod(name, (params) => method(params));
  }

  /** Send a one-way notification to the remote side */
  notify(method: string, params: unknown): void {
    this.peer.notify(method, params, undefined);
  }

  /** Send a request to the remote side and wait for a response */
  request(method: string, params: unknown): Promise<unknown> {
    return Promise.resolve(this.peer.request(method, params, undefined));
  }

  /**
   * Process a single line/message received from the transport.
   * Works for both NDJSON lines (net.Socket) and WS text frames.
   * Returns true if the line was a valid JSON-RPC payload.
   */
  handleLine(line: string): boolean {
    const t0 = Date.now();
    const payload = safeJsonParse(line);
    if (payload === undefined) {
      console.error("[RpcConnection] Failed to parse JSON:", line);
      return false;
    }
    if (!isJsonRpcPayload(payload)) {
      console.error("[RpcConnection] Received non-JSON-RPC payload:", payload);
      return false;
    }

    const method = (payload as any)?.method;
    if (method) {
      console.log(
        `[TIMING][RpcConnection] handleLine method=${method} parseTime=${Date.now() - t0}ms lineLen=${line.length}`
      );
    }

    void this.peer.receiveAndSend(payload, undefined, undefined).catch((e) => {
      console.error("[RpcConnection] Failed to handle message:", e);
    });
    return true;
  }

  /** Alias for handleLine — clearer name when used with WebSocket messages. */
  handleMessage(message: string): boolean {
    return this.handleLine(message);
  }

  /** Reject all pending outbound requests and tear down the connection */
  stop(): void {
    this.peer.rejectAllPendingRequests("RPC connection stopped");
  }
}
