/**
 * Hosted assistants: the ones that signed in to this computer through the Deus
 * account, and what the person allowed each to do. (The address to paste into
 * one is on `relayStatus`: it is the tunnel's.) Full access only, except
 * `agentMcp`: the only operation an assistant itself may ask for.
 */

import { z } from "zod";
import type { Assistant, AssistantDecision } from "../types/assistants";
import { live, out, write } from "./op";

// ---- The operator tools, over MCP ----

/**
 * One Model Context Protocol message (or a batch array) for this computer's
 * operator tools, answered here: the JSON-RPC response, an array for a batch,
 * or null when there is nothing to answer (a notification). Deus Cloud only
 * carries an assistant's request here and its answer back.
 *
 * `tools/list` is the same for every caller (assistants keep it from when they
 * connect, so it cannot follow an access level). A `tools/call` runs under the
 * caller's access; a refusal (not allowed yet, read only, denied, an unknown
 * session) is a tool result with `isError` whose text says what to do instead.
 * This computer's window and paired devices may call it too.
 */
export const agentMcp = write({
  name: "agentMcp",
  // Passed through as it came: the MCP handler answers a malformed message itself.
  input: z.object({ message: z.unknown() }),
  output: out<unknown>(),
});

// ---- Managing them (full access only) ----

const clientId = z.string().min(1);

/** Every assistant that reached this computer under the signed-in account, newest first. */
export const assistants = live({
  name: "assistants",
  output: out<Assistant[]>(),
});

/**
 * Allow an assistant to read or to operate, or deny it (it stays listed, and
 * refused, until it is removed). Its open connections are closed.
 */
export const setAssistantAccess = write({
  name: "setAssistantAccess",
  input: z.object({
    clientId,
    access: z.enum(["read", "operate", "denied"] as const satisfies readonly AssistantDecision[]),
  }),
  output: out<void>(),
});

/** Forget an assistant. Its open connections are closed; its next contact is a first contact. */
export const removeAssistant = write({
  name: "removeAssistant",
  input: z.object({ clientId }),
  output: out<void>(),
});
