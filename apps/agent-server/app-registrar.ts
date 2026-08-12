// agent-server/app-registrar.ts
// AAP dynamic MCP registry: apps register/unregister MCP servers at runtime
// and every live Claude session picks them up mid-conversation.
//
// Since the @zvada/agent-server/core embedding, all the per-query bookkeeping this
// file used to carry (protected SDK servers, attach/detach lifecycles,
// per-query payload merging) lives in the engine: `setAapMcpServers` persists
// the map for future turns and live-swaps it onto running sessions via the
// engine's `ClaudeCodeAgent.setMcpServers`, which re-merges the in-process
// `deus` tool server on every swap — an AAP app can never drop the host's own
// tools, and a failed swap throws instead of silently reporting "attached".

import type { McpServerConfig } from "@zvada/agent-server/protocol";
import { getErrorMessage } from "@shared/lib/errors";
import { setAapMcpServers } from "./agents/core/core-handler";

/** Registered AAP servers by normalized app id (e.g. `deus_mobile_use`). */
const registeredServers = new Map<string, McpServerConfig>();

/**
 * All registry mutations run FIFO through one chain so interleaved
 * register/unregister calls can't broadcast out of order.
 */
let updateChain: Promise<void> = Promise.resolve();

function enqueueRegistryUpdate<T>(fn: () => Promise<T>): Promise<T> {
  const run = updateChain.then(fn, fn);
  updateChain = run.then(
    () => undefined,
    (err) => {
      console.warn(`[AAP-Registrar] update failed: ${getErrorMessage(err)}`);
    }
  );
  return run;
}

function broadcast(): Promise<void> {
  return setAapMcpServers(Object.fromEntries(registeredServers));
}

/**
 * Register an AAP MCP server. Adds to the map and pushes the FULL current
 * state to every live Claude session (and every future turn). Idempotent in
 * effect: re-registering the same pair re-broadcasts the same payload.
 */
export function registerAppMcp(serverName: string, url: string): Promise<void> {
  return enqueueRegistryUpdate(async () => {
    registeredServers.set(serverName, { type: "http", url });
    console.log(
      `[AAP-Registrar] Registered ${serverName} → ${url} (${registeredServers.size} total)`
    );
    await broadcast();
  });
}

/**
 * Unregister an AAP MCP server. Silent no-op (no broadcast) when the server
 * wasn't registered — we don't thrash live sessions for a map that didn't
 * actually change.
 */
export function unregisterAppMcp(serverName: string): Promise<void> {
  return enqueueRegistryUpdate(async () => {
    const existed = registeredServers.delete(serverName);
    if (!existed) return;
    console.log(`[AAP-Registrar] Unregistered ${serverName} (${registeredServers.size} remaining)`);
    await broadcast();
  });
}

/**
 * Clear the registrar state.
 *
 * @internal
 * Test-only. Production code must never call this.
 */
export function __clearRegistrarForTests(): void {
  registeredServers.clear();
}
