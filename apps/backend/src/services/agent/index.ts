// backend/src/services/agent/index.ts
// Barrel — re-exports for external consumers.
//
// External code (server.ts, query-engine.ts) imports from "./agent"
// and gets a unified public API without knowing the internal file layout.

export {
  init,
  shutdown,
  startTurn,
  stopSession,
  isConnected,
  checkAuth,
  getAgents,
  registerAapMcp,
  unregisterAapMcp,
} from "./service";

export { runCommand } from "./commands";
export { resolve as resolveToolRelay, reject as rejectToolRelay } from "./tool-relay";
