// backend/src/services/agent/index.ts
// Barrel — re-exports for external consumers.
//
// External code (server.ts, query-engine.ts) imports from "./agent"
// and gets a unified public API without knowing the internal file layout.

export {
  init,
  shutdown,
  forwardTurn,
  respondToAgent,
  stopSession,
  isConnected,
  checkAuth,
  getAgents,
} from "./service";

export { runCommand } from "./commands";
export { resolve as resolveToolRelay, reject as rejectToolRelay } from "./tool-relay";
export { createAgentEventHandler, type AgentEventHandler } from "./event-handler";
