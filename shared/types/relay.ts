// Relay envelope protocol types (relay protocol v2).
// Defines the framing between Deus server <-> CF Durable Object relay <-> web clients.
// Every socket is admitted with a Deus Cloud ticket before any frame below is
// exchanged; `accountId` on host-bound frames is the account that ticket proved.

/**
 * Every peer offers `[RELAY_PROTOCOL, <Deus Cloud ticket>]` as its WebSocket
 * subprotocols; the relay echoes RELAY_PROTOCOL back once the ticket verifies.
 */
export const RELAY_PROTOCOL = "deus.relay.v2";

// ---- Server <-> Relay (tunnel) ----

/** Frames sent from Deus server to relay via tunnel WebSocket */
export type ServerFrame =
  | { type: "register"; serverName?: string }
  | { type: "data"; clientId: string; payload: string }
  | { type: "auth_response"; clientId: string; allowed: boolean; reason?: string }
  | { type: "pong" }
  // Pairing: desktop validated the code, returning the device token (or error)
  | { type: "pair_response"; pairId: string; success: true; deviceToken: string }
  | { type: "pair_response"; pairId: string; success: false; reason: string };

/** Frames sent from relay to Deus server via tunnel WebSocket */
export type RelayFrame =
  | { type: "registered" }
  | { type: "client_connected"; clientId: string; deviceToken: string; accountId: string }
  | { type: "client_disconnected"; clientId: string }
  | { type: "data"; clientId: string; payload: string }
  | { type: "ping" }
  | { type: "error"; message: string }
  // Pairing: web client wants to exchange a code for a device token
  | { type: "pair_request"; pairId: string; code: string; deviceName: string; accountId: string };

// ---- Client <-> Relay ----

/** Control frames sent from relay to client (auth + lifecycle) */
export type RelayClientFrame =
  | { type: "pong"; id: string }
  | { type: "authenticated" }
  | { type: "auth_failed"; message: string }
  | { type: "server_reconnecting"; serverName: string | null; serverDisconnectedAt: number }
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

// ---- Aliases (used by cloud-relay Durable Object) ----

export type PairerFrame = PairerRequestFrame;
export type RelayPairerFrame = PairerResponseFrame;
