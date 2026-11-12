// backend/src/services/agent/index.ts
// Barrel — re-exports for external consumers.
//
// External code (server.ts, query-engine.ts) imports from "./agent"
// and gets a unified public API without knowing the internal file layout.

export { init, shutdown, startTurn, stopSession, isConnected, getLocalAgents } from "./service";

export { resolve as resolveToolRelay, reject as rejectToolRelay } from "./tool-relay";
