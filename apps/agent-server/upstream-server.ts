// agent-server/upstream-server.ts
// Deep import of the upstream wire server, bypassing the package's /server
// index: that index re-exports the ACP stdio binding, whose node↔DOM
// ReadableStream cast doesn't compile under this app's DOM-inclusive libs
// (the recording/canvas subtree needs DOM types). Deus registers only the
// three native harnesses — the ACP binding must stay out of this program.

export {
  AgentServer,
  type AgentServerOptions,
} from "../../node_modules/@zvada/agent-server/src/server/agent-server.ts";
