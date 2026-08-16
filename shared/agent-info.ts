// shared/agent-info.ts
// What deus knows about the harnesses the engine actually has available.
//
// This is the last survivor of the old `agent-events.ts`: the lifecycle events
// themselves are the engine's (see shared/protocol-types.ts), but the settings
// surface still needs a small, serializable answer to "which agents can I use
// and what can they do". Capabilities are NEGOTIATED — they come from the
// `initialize` handshake, never fabricated by deus.

import { z } from "zod";

import { AgentHarnessSchema } from "./enums";

/** One available harness, as reported by the initialize handshake. */
export interface AgentInfo {
  type: import("./enums").AgentHarness;
  capabilities: import("./protocol-types").AgentCapabilities;
}

// ============================================================================
// Provider auth (deus/* side channel)
// ============================================================================

export const ProviderAuthRequestSchema = z.object({
  agentHarness: AgentHarnessSchema,
  cwd: z.string().min(1),
});
export type ProviderAuthRequest = z.infer<typeof ProviderAuthRequestSchema>;
