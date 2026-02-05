// sidecar/rpc-connection.ts
// Bidirectional JSON-RPC 2.0 connection over a raw TCP/Unix socket.
// Each JSON-RPC message is a single newline-delimited JSON line.

import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
  isJSONRPCRequest,
  isJSONRPCRequests,
  isJSONRPCResponse,
  isJSONRPCResponses,
} from "json-rpc-2.0";
import type { Socket } from "net";

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

export class RpcConnection {
  private socket: Socket;
  private peer: JSONRPCServerAndClient;

  constructor(socket: Socket) {
    this.socket = socket;

    const server = new JSONRPCServer({
      errorListener: (message, data) => {
        console.error("[RpcConnection] Server error:", message, data);
      },
    });

    const client = new JSONRPCClient((payload) => {
      if (this.socket.destroyed) {
        return Promise.reject(new Error("Socket is destroyed"));
      }
      try {
        this.socket.write(JSON.stringify(payload) + "\n");
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

  /** Register a method handler that the frontend can call */
  addMethod(name: string, method: (params: unknown) => Promise<unknown>): void {
    this.peer.addMethod(name, (params) => method(params));
  }

  /** Send a one-way notification to the frontend */
  notify(method: string, params: unknown): void {
    this.peer.notify(method, params, undefined);
  }

  /** Send a request to the frontend and wait for a response */
  request(method: string, params: unknown): Promise<unknown> {
    return Promise.resolve(this.peer.request(method, params, undefined));
  }

  /**
   * Process a single newline-delimited line received from the socket.
   * Returns true if the line was a valid JSON-RPC payload.
   */
  handleLine(line: string): boolean {
    const payload = safeJsonParse(line);
    if (payload === undefined) {
      console.error("[RpcConnection] Failed to parse JSON:", line);
      return false;
    }
    if (!isJsonRpcPayload(payload)) {
      console.error("[RpcConnection] Received non-JSON-RPC payload:", payload);
      return false;
    }

    void this.peer.receiveAndSend(payload, undefined, undefined).catch((e) => {
      console.error("[RpcConnection] Failed to handle message:", e);
    });
    return true;
  }

  /** Reject all pending outbound requests and tear down the connection */
  stop(): void {
    this.peer.rejectAllPendingRequests("RPC connection stopped");
  }
}
