// agent-server/wire.ts
// Bridges WebSocket connections onto the upstream @zvada/agent-server wire:
// each socket becomes a WireTransport; deus/* side-channel frames are claimed
// before AgentServer sees the line; everything else (turn/start, turn/cancel,
// events/replay, …) is the standard protocol.
//
// Passive riders on the inbound path:
//   - turn/start feeds the session tracker (cwd/harness for the embed-tier
//     seams) and gets the current AAP MCP server set injected into its config
//     (claude only — parity with the legacy per-turn `mcpServers` assembly);
//   - turn/cancel triggers the eager end checkpoint (a forced kill can beat
//     the engine's Stop hook).
// And on the outbound broadcast: an observer transport feeds turn boundaries,
// native session ids, and the title watcher.

import type { WebSocket } from "ws";
import type { AgentServer } from "./upstream-server";
import {
  channelTransport,
  decodeWireMessage,
  encodeRequest,
  WireEventEnvelopeSchema,
} from "@zvada/agent-server/protocol";
import {
  SIDE_CHANNEL,
  SideChannelEndpoint,
  filterClaimedLines,
  wsLineTransport,
} from "@shared/agent-side-channel";
import type { LineTransport } from "@shared/agent-side-channel";
import { registerAppMcp, unregisterAppMcp } from "./app-registrar";
import { createCheckpoint } from "./agents/core/checkpoint";
import { currentAapServers } from "./agents/core/engine";
import { clearHost, setHost } from "./host-link";
import { providerAuth } from "./provider-auth";
import { RegisterAppMcpRequestSchema, UnregisterAppMcpRequestSchema } from "./rpc-schemas";
import { observeLifecycleEvent, observeTurnStart, trackedSessions } from "./session-tracker";
import { maybeFetchTitle } from "./title-watch";

interface PendingTurnStart {
  sessionId?: string;
  turnId?: string;
  config?: {
    harness?: string;
    cwd?: string;
    additionalDirectories?: string[];
    mcpServers?: Record<string, unknown>;
  };
}

/**
 * Observe (and possibly rewrite) an inbound non-side-channel line.
 * Returns a replacement line, or undefined to pass the original through.
 *
 * turn/start is NOT tracked here — a rejected request (bad harness, shutting
 * down, …) must never pollute the session tracker with a turn that will
 * never run. The request is parked in `pendingStarts` and committed only
 * when the outbound ACK confirms the server accepted it (the quick-ack is
 * sent before the first event can be emitted, so the tracker is always
 * populated before the embed seams consult it).
 */
function observeInboundLine(
  line: string,
  pendingStarts: Map<string | number, PendingTurnStart>
): string | undefined {
  // Cheap pre-filter: only turn/start + turn/cancel requests matter here.
  if (!line.includes('"turn/')) return undefined;
  const msg = decodeWireMessage(line);
  if (msg.kind !== "request") return undefined;

  if (msg.method === "turn/start") {
    const params = (msg.params ?? {}) as PendingTurnStart;
    pendingStarts.set(msg.id, params);
    // AAP parity with the legacy handler: every claude turn carries the
    // currently registered AAP MCP servers in its wire config (the engine
    // hot-swaps mcpServers between turns without a session restart).
    const aapServers = currentAapServers();
    if (params.config?.harness === "claude-code" && Object.keys(aapServers).length) {
      params.config.mcpServers = { ...aapServers, ...(params.config.mcpServers ?? {}) };
      return encodeRequest(msg.id, msg.method, params);
    }
    return undefined;
  }

  if (msg.method === "turn/cancel") {
    // A forced cancellation can kill the subprocess before the Stop hook runs —
    // create the end checkpoint first so undo/revert still has its ref
    // (createCheckpoint is a no-op outside a git repo). Guards: claude only,
    // and an active turn (turnId clears at turn end — a stale checkpoint here
    // would fold post-turn edits into "state at end of turn N" and break undo).
    const sessionId = (msg.params as { sessionId?: string } | undefined)?.sessionId;
    if (sessionId) {
      const state = trackedSessions.get(sessionId);
      if (state?.harness === "claude-code" && state.turnId && state.cwd) {
        createCheckpoint(sessionId, state.turnId, "end", state.cwd, "[wire]");
      }
    }
  }
  return undefined;
}

/** Commit a parked turn/start once its outbound response proves acceptance. */
function observeOutboundLine(
  line: string,
  pendingStarts: Map<string | number, PendingTurnStart>
): void {
  if (pendingStarts.size === 0) return;
  const msg = decodeWireMessage(line);
  if (msg.kind !== "response" || msg.id === null) return;
  const pending = pendingStarts.get(msg.id);
  if (pending === undefined) return;
  pendingStarts.delete(msg.id);
  // A rejected start (error response) never touches the tracker: an active
  // session keeps its live turn's cwd/dirs, an idle session stays idle so the
  // corrected retry records ITS config instead of the rejected one's.
  if (msg.error) return;
  const active = pending.sessionId ? trackedSessions.get(pending.sessionId) : undefined;
  if (active?.turnId === undefined) observeTurnStart(pending);
}

/** Wire one accepted WebSocket into the server + side channel. */
export function bridgeWsConnection(ws: WebSocket, agentServer: AgentServer): void {
  ws.on("error", (error: Error) => {
    console.error("[wire] WebSocket error:", error.message);
  });
  const transport = wsLineTransport(ws);

  const sideChannel = new SideChannelEndpoint((line) => transport.send(line), "agent-server");
  sideChannel.onNotification(SIDE_CHANNEL.hello, () => setHost(sideChannel));
  sideChannel.onRequest(SIDE_CHANNEL.providerAuth, providerAuth);
  sideChannel.onRequest(SIDE_CHANNEL.aapRegisterMcp, async (params) => {
    const parsed = RegisterAppMcpRequestSchema.parse(params);
    await registerAppMcp(parsed.serverName, parsed.url);
    return { added: [parsed.serverName] };
  });
  sideChannel.onRequest(SIDE_CHANNEL.aapUnregisterMcp, async (params) => {
    const parsed = UnregisterAppMcpRequestSchema.parse(params);
    await unregisterAppMcp(parsed.serverName);
    return { removed: [parsed.serverName] };
  });
  transport.onClose(() => {
    sideChannel.failPending("connection closed");
    clearHost(sideChannel);
  });

  // Claim side-channel frames once; observe/rewrite the rest; forward to the
  // wire. Outbound responses commit parked turn/starts on acceptance.
  const pendingStarts = new Map<string | number, PendingTurnStart>();
  const filtered = filterClaimedLines(
    {
      send: (line) => {
        observeOutboundLine(line, pendingStarts);
        transport.send(line);
      },
      onLine: (handler) => transport.onLine(handler),
      onClose: (handler) => transport.onClose(handler),
      close: () => transport.close(),
      get closed() {
        return transport.closed;
      },
    },
    (line) => sideChannel.handleLine(line),
    (line) => observeInboundLine(line, pendingStarts)
  );

  agentServer.attach(filtered);
  console.log("[wire] Client connected");
}

/**
 * An in-memory transport attached to the server purely to observe the event
 * broadcast (transports receive every envelope via send). Feeds the session
 * tracker and the title watcher. The substring pre-filter skips the hot
 * delta stream without parsing; the parsed type check keeps correctness when
 * a delta happens to contain one of the literals.
 */
export function createEventObserverTransport(): LineTransport {
  const { transport } = channelTransport({
    send: (line) => {
      if (
        !line.includes('"session.created"') &&
        !line.includes('"turn.started"') &&
        !line.includes('"turn.ended"')
      ) {
        return;
      }
      const msg = decodeWireMessage(line);
      if (msg.kind !== "notification" || msg.method !== "event") return;
      const envelope = WireEventEnvelopeSchema.safeParse(msg.params);
      if (!envelope.success) return;
      const event = envelope.data.event;
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
      if (event.type === "turn.ended") {
        // Successful turns kick the title fetch; errors/cancels don't.
        if (event.stopReason !== "error" && event.stopReason !== "cancelled") {
          maybeFetchTitle(event.sessionId);
        }
      }
    },
  });
  return transport as LineTransport;
}
