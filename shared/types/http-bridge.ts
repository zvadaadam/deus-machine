// HTTP-over-WebSocket bridge types.
// Used to tunnel REST API requests through the relay WebSocket connection.
// The relay forwards these as opaque data payloads (no relay changes needed).

/** Sent by the web frontend to request an HTTP endpoint via the WS tunnel. */
export interface HttpRequestFrame {
  type: "http:request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Sent by the desktop backend in response to an http:request. */
export interface HttpResponseFrame {
  type: "http:response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}
