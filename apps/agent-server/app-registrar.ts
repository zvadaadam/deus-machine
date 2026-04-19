// apps/agent-server/app-registrar.ts
// AAP MCP registrar — holds the dynamic mcp-http server map and broadcasts
// updates to every live Claude Query.
//
// The SDK contract (sdk.d.ts:1373):
//   `setMcpServers(servers: Record<string, McpServerConfig>)`
// REPLACES the dynamic-server map — NOT merges. So every register/unregister
// must pass the FULL current state. The module-scope Map is the single source
// of truth; we rebuild the broadcast payload from it each time.
//
// Critical: "the full current state" INCLUDES the session's initial SDK
// servers (the `deus` server carrying workspace/browser/simulator/apps
// tools). The SDK's setMcpServers disconnects any SDK server not in its
// input — so omitting `deus` silently kills the transport that's relaying
// the pending `launch_app` tool result back to the CLI, hanging the call.
// To protect those we need a per-query handle to the SDK-server instances;
// see `attachQuery` / `protectedByQuery` below.
//
// Broadcast strategy: iterate every active Claude Query (via
// `claudeQueries.values()`) and call `setMcpServers` on each. If the SDK
// throws on one (disposed generator, closed query) we swallow and continue
// — one dead session must not block registration on the others.
//
// Called from:
//   - Inbound RPCs: `aap/register-mcp` + `aap/unregister-mcp` (wired in index.ts)
//   - Query lifecycle: claude-handler calls `attachQuery` after construction
//     and `detachQuery` in the finally block.

import type {
  Query,
  McpServerConfig,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

import { claudeQueries } from "./agents/claude/claude-session";
import { getErrorMessage } from "@shared/lib/errors";

// ----------------------------------------------------------------------------
// Module state — single source of truth for the dynamic MCP map.
// ----------------------------------------------------------------------------

/** Currently-registered dynamic MCP servers. Key = SDK server name (normalized
 *  via `idToServerName`). Value = HTTP transport config. Must stay in sync
 *  with what's been pushed to each Query via setMcpServers. */
const registeredServers = new Map<string, McpServerConfig>();

/** Per-query list of SDK-type MCP servers that must be preserved across every
 *  setMcpServers broadcast. The SDK disconnects any SDK server not in the
 *  input map, which would sever the transport mid-tool-call for in-flight
 *  invocations on those servers. Populated from `sdkOptions.mcpServers` when
 *  the Query is created. */
const protectedByQuery = new Map<Query, Record<string, McpSdkServerConfigWithInstance>>();

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Register an AAP MCP server. Adds to the map and broadcasts the FULL current
 * state to every active Claude Query.
 *
 * Idempotent in effect: registering the same (serverName, url) pair twice
 * results in two broadcasts of the same payload — the SDK treats it as a
 * re-set, not a duplicate.
 */
export async function registerAppMcp(serverName: string, url: string): Promise<void> {
  const config: McpServerConfig = { type: "http", url };
  registeredServers.set(serverName, config);
  console.log(
    `[AAP-Registrar] Registered ${serverName} → ${url} (${registeredServers.size} total)`
  );
  await broadcast();
}

/**
 * Unregister an AAP MCP server. Removes from the map and broadcasts. If the
 * server wasn't registered, this is a silent no-op (no broadcast — we don't
 * thrash the SDK for a map that didn't actually change).
 */
export async function unregisterAppMcp(serverName: string): Promise<void> {
  const existed = registeredServers.delete(serverName);
  if (!existed) return;
  console.log(`[AAP-Registrar] Unregistered ${serverName} (${registeredServers.size} remaining)`);
  await broadcast();
}

/**
 * Record a Query's protected SDK servers (the `deus` server carrying our
 * own tools, etc.) so every subsequent setMcpServers broadcast includes
 * them. Call this immediately after `claudeQueries.set(sessionId, query)`
 * in claude-handler.
 */
export function attachQuery(
  query: Query,
  sdkServers: Record<string, McpSdkServerConfigWithInstance>
): void {
  protectedByQuery.set(query, sdkServers);
}

/** Symmetric counterpart to `attachQuery`. Call from claude-handler's
 *  finally block, alongside `claudeQueries.delete(sessionId)`. */
export function detachQuery(query: Query): void {
  protectedByQuery.delete(query);
}

/**
 * Push the current map to every active Query. Per-query errors are logged
 * and swallowed so a single dead Query can't block the others.
 */
async function broadcast(): Promise<void> {
  const dynamicPayload: Record<string, McpServerConfig> = {};
  for (const [name, config] of registeredServers) {
    dynamicPayload[name] = config;
  }

  const queries: Query[] = [...claudeQueries.values()];
  if (queries.length === 0) {
    console.log(`[AAP-Registrar] No active queries to broadcast to (state stored for later)`);
    return;
  }

  await Promise.all(
    queries.map(async (query) => {
      // Merge the dynamic AAP servers with this query's protected SDK servers.
      // Dynamic names and protected names don't collide in practice (AAP
      // server names are normalized appIds like `deus_mobile_use`; protected
      // is the single built-in `deus`), but if they ever do the dynamic
      // entry wins — an AAP app can't shadow the host's own tools without
      // an explicit override. That's the safer default.
      const protectedSdkServers = protectedByQuery.get(query) ?? {};
      const payload: Record<string, McpServerConfig> = {
        ...protectedSdkServers,
        ...dynamicPayload,
      };
      try {
        await query.setMcpServers(payload);
      } catch (err) {
        // Swallow per-query failures. Common causes: the Query has been
        // disposed, the underlying CLI subprocess exited, the SDK transport
        // closed. Logging is enough — nothing downstream cares.
        console.warn(`[AAP-Registrar] setMcpServers failed on one query: ${getErrorMessage(err)}`);
      }
    })
  );
}

// ----------------------------------------------------------------------------
// Test hooks
// ----------------------------------------------------------------------------

/**
 * Clear the registrar state.
 *
 * @internal
 * Test-only. Production code must never call this.
 */
export function __clearRegistrarForTests(): void {
  registeredServers.clear();
  protectedByQuery.clear();
}
