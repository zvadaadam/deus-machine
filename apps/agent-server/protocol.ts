// agent-server/protocol.ts
// Protocol definitions for JSON-RPC 2.0 communication between the
// Deus backend and the agent-server agent runtime.
//
// Query/options schemas (QueryOptions) are canonical in shared/protocol.ts.
// MCP-facing RPC schemas (diff, terminal, plan mode, AAP) live in
// rpc-schemas.ts; re-exported here.

import { z } from "zod";
import { AgentHarnessSchema, ErrorCategorySchema } from "@shared/enums";

// Canonical schemas — re-exported for existing agent-server imports.
export { QueryOptionsSchema } from "@shared/protocol";

export type { QueryOptions } from "@shared/protocol";

/** RPC methods the agent-server can call on the frontend (request/response).
 *  Canonical definition in shared/agent-events.ts; re-exported here. */
export { FRONTEND_RPC_METHODS } from "@shared/agent-events";

// Canonical shared schemas — re-exported here for backwards compatibility with
// existing agent-server imports.
export { AgentHarnessSchema, ErrorCategorySchema };

export type AgentHarness = z.infer<typeof AgentHarnessSchema>;
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

// ============================================================================
// RPC Request/Response Schemas (agent-server ⇄ backend/frontend)
// ============================================================================

export * from "./rpc-schemas";
