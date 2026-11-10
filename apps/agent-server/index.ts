// agent-server/index.ts
// The engine, in the backend's process: the standard @zvada/agent-server wire
// on an in-process channel, with deus's seams around it — the in-process deus
// MCP tools (answered by the backend through `host-link`), the tool policy,
// the checkpoint hooks, session titles and the AAP MCP servers.

import { AgentServer } from "@zvada/agent-server/server";
import {
  channelPair,
  type TurnStartParams,
  type WireTransport,
} from "@zvada/agent-server/protocol";
import { adoptBundledClis } from "./agents/core/bundled-clis";
import { createCheckpoint } from "./agents/core/checkpoint";
import { currentAapServers, getRuntime } from "./agents/core/engine";
import { applyShellEnvironment } from "./agents/environment";
import { setHost, type DeusHost } from "./host-link";
import {
  observeLifecycleEvent,
  observeTurnStart,
  sessionServers,
  trackedSessions,
} from "./session-tracker";
import { maybeFetchTitle } from "./title-watch";

export type { DeusHost, SessionTitle } from "./host-link";
export { registerAppMcp, unregisterAppMcp } from "./app-registrar";

let server: AgentServer | null = null;

/** The engine's runtime, its CLIs and environment settled first. */
function engineRuntime() {
  adoptBundledClis();
  applyShellEnvironment();
  return getRuntime();
}

/**
 * Start the engine for `host`, the backend, and return the client's end of
 * its wire. Packaged and staged runtimes adopt the bundled CLIs before the
 * registry exists; a source run folds the login shell's environment in.
 * `runtime` is for tests.
 */
export function startEngine(
  host: DeusHost,
  runtime: ConstructorParameters<typeof AgentServer>[0] = engineRuntime()
): WireTransport {
  if (server) throw new Error("The engine is already running");
  setHost(host);
  server = new AgentServer(runtime, { info: { name: "deus-agent-server" } });
  // Turn boundaries and native ids feed the session tracker (cwd and harness
  // for the tool policy, checkpoints and titles); a clean Claude turn end
  // fetches the session's title.
  server.onEvent(({ event }) => {
    if (
      event.type !== "session.created" &&
      event.type !== "turn.started" &&
      event.type !== "turn.ended"
    ) {
      return;
    }
    observeLifecycleEvent({
      type: event.type,
      sessionId: event.sessionId,
      turnId: "turnId" in event ? event.turnId : undefined,
      nativeSessionId: "nativeSessionId" in event ? event.nativeSessionId : undefined,
    });
    if (
      event.type === "turn.ended" &&
      event.stopReason !== "error" &&
      event.stopReason !== "cancelled"
    ) {
      maybeFetchTitle(event.sessionId);
    }
  });
  const channel = channelPair();
  server.attach(channel.server);
  return channel.client;
}

/** Cancel the turns under way and stop the CLIs the engine started. */
export async function stopEngine(): Promise<void> {
  const running = server;
  server = null;
  setHost(null);
  await running?.shutdown();
}

/**
 * A turn about to be sent. A Claude turn carries the registered AAP servers
 * in its config (the engine swaps a session's servers between turns). The
 * session tracker records the turn's cwd, harness and directories now, since
 * the hooks can consult it before the ack returns; a session with a turn
 * under way keeps its turn's. `refused` undoes the record for a turn the
 * server refused.
 */
export function beginTurnStart(params: TurnStartParams): {
  params: TurnStartParams;
  refused: () => void;
} {
  const aapServers = currentAapServers();
  const sent =
    params.config.harness === "claude-code" && Object.keys(aapServers).length
      ? {
          ...params,
          config: {
            ...params.config,
            mcpServers: sessionServers(aapServers, params.config.mcpServers),
          },
        }
      : params;
  const sessionId = params.sessionId;
  const previous = sessionId ? trackedSessions.get(sessionId) : undefined;
  const recorded = sessionId !== undefined && previous?.turnId === undefined;
  if (recorded) observeTurnStart(params);
  return {
    params: sent,
    refused: () => {
      if (!recorded) return;
      if (previous) trackedSessions.set(sessionId, previous);
      else trackedSessions.delete(sessionId);
    },
  };
}

/**
 * Before a cancel, write the running Claude turn's end checkpoint: a forced
 * stop can end the CLI before its Stop hook runs, and undo needs the ref. A
 * session with no turn under way gets none (a stale one would fold later
 * edits into "the end of turn N").
 */
export async function beforeCancel(sessionId: string): Promise<void> {
  const state = trackedSessions.get(sessionId);
  if (state?.harness === "claude-code" && state.turnId && state.cwd) {
    await createCheckpoint(sessionId, state.turnId, "end", state.cwd, "[engine]");
  }
}
