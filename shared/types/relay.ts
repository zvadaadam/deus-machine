// Relay envelope protocol types (copy from devs-web packages/types/src/relay.ts).
// Defines the framing between Hive server ↔ CF Durable Object relay ↔ web clients.

// ---- Server ↔ Relay (tunnel) ----

/** Frames sent from Hive server to relay via tunnel WebSocket */
export type ServerFrame =
  | { type: "register"; serverId: string; relayToken: string }
  | { type: "data"; clientId: string; payload: string }
  | { type: "auth_response"; clientId: string; allowed: boolean; reason?: string }
  | { type: "pong" };

/** Frames sent from relay to Hive server via tunnel WebSocket */
export type RelayFrame =
  | { type: "registered" }
  | { type: "client_connected"; clientId: string; deviceToken: string }
  | { type: "client_disconnected"; clientId: string }
  | { type: "data"; clientId: string; payload: string }
  | { type: "ping" }
  | { type: "error"; message: string };

// ---- Client ↔ Relay ----

/** First message a client sends after WebSocket connect */
export type ClientAuthFrame = { type: "authenticate"; token: string };

/** Control frames sent from relay to client (auth + lifecycle) */
export type RelayClientFrame =
  | { type: "authenticated" }
  | { type: "auth_failed"; message: string }
  | { type: "server_offline" }
  | { type: "server_reconnecting" }
  | { type: "error"; message: string };
