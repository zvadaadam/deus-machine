// Relay envelope protocol types (copy from devs-web packages/types/src/relay.ts).
// Defines the framing between OpenDevs server <-> CF Durable Object relay <-> web clients.

// ---- Server <-> Relay (tunnel) ----

/** Frames sent from OpenDevs server to relay via tunnel WebSocket */
export type ServerFrame =
  | { type: "register"; serverId: string; relayToken: string; serverName?: string }
  | { type: "data"; clientId: string; payload: string }
  | { type: "auth_response"; clientId: string; allowed: boolean; reason?: string }
  | { type: "pong" }
  // Pairing: desktop validated the code, returning the device token (or error)
  | { type: "pair_response"; pairId: string; success: true; deviceToken: string }
  | { type: "pair_response"; pairId: string; success: false; reason: string };

/** Frames sent from relay to OpenDevs server via tunnel WebSocket */
export type RelayFrame =
  | { type: "registered" }
  | { type: "client_connected"; clientId: string; deviceToken: string }
  | { type: "client_disconnected"; clientId: string }
  | { type: "data"; clientId: string; payload: string }
  | { type: "ping" }
  | { type: "error"; message: string }
  // Pairing: web client wants to exchange a code for a device token
  | { type: "pair_request"; pairId: string; code: string; deviceName: string };

// ---- Client <-> Relay ----

/** First message a client sends after WebSocket connect */
export type ClientAuthFrame = { type: "authenticate"; token: string };

/** Control frames sent from relay to client (auth + lifecycle) */
export type RelayClientFrame =
  | { type: "authenticated" }
  | { type: "auth_failed"; message: string }
  | { type: "server_offline" }
  | { type: "server_reconnecting" }
  | { type: "error"; message: string };

// ---- Pairer <-> Relay (one-shot /pair WebSocket) ----

/** Frame sent from web portal to relay during pairing */
export type PairerRequestFrame = {
  type: "pair_request";
  code: string;
  deviceName: string;
};

/** Control frames sent from relay to web portal pairer */
export type PairerResponseFrame =
  | { type: "pair_success"; token: string }
  | { type: "pair_failed"; message: string };
