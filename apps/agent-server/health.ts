// agent-server/health.ts
// Health endpoint handler and graceful shutdown coordinator for the agent-server.
//
// Health: GET /health returns uptime, memory, agents, connections.
// Readiness: GET /readyz returns 200 if agents are initialized, 503 if not.
// Graceful shutdown: drains in-flight turns before closing connections.

import type { IncomingMessage, ServerResponse } from "http";
import type { WebSocketServer } from "ws";
import { getRegisteredAgentHarnesses, getAgent } from "./agents/registry";
import type { AgentHarness } from "@shared/enums";
import { EventBroadcaster } from "./event-broadcaster";

// ============================================================================
// Types
// ============================================================================

export interface HealthResponse {
  status: "ok";
  uptime: number;
  memoryMb: number;
  agents: string[];
  connections: number;
  version: string;
  timestamp: string;
}

export interface ShutdownConfig {
  /** Maximum time (ms) to wait for in-flight turns to drain. Default: 30_000 */
  drainTimeoutMs: number;
}

const DEFAULT_SHUTDOWN_CONFIG: ShutdownConfig = {
  drainTimeoutMs: 30_000,
};

// ============================================================================
// Module state
// ============================================================================

/** Set to true once agents have been initialized */
let agentsInitialized = false;

/** Set to true when shutdown has been signaled */
let shuttingDown = false;

/** Active sessions (sessionId -> agentHarness). Add on turn/start, remove on idle/error/cancelled. */
const activeSessions = new Map<string, string>();

/** Process start time, used for uptime calculation */
const startTime = Date.now();

// ============================================================================
// State accessors (exported for index.ts and tests)
// ============================================================================

export function setAgentsInitialized(value: boolean): void {
  agentsInitialized = value;
}

export function isAgentsInitialized(): boolean {
  return agentsInitialized;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function getActiveSessions(): Map<string, string> {
  return activeSessions;
}

export function trackSession(sessionId: string, agentHarness: string): void {
  activeSessions.set(sessionId, agentHarness);
}

export function untrackSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}

// ============================================================================
// Health endpoint handler
// ============================================================================

/**
 * Builds the health response payload.
 * Separated from the HTTP handler so it can be tested independently.
 */
export function buildHealthResponse(wss: WebSocketServer | null): HealthResponse {
  const uptimeSeconds = (Date.now() - startTime) / 1000;
  const memoryMb = Math.round((process.memoryUsage.rss() / 1024 / 1024) * 100) / 100;
  const agents = getRegisteredAgentHarnesses();
  const connections = wss ? wss.clients.size : 0;

  return {
    status: "ok",
    uptime: Math.round(uptimeSeconds * 100) / 100,
    memoryMb,
    agents,
    connections,
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  };
}

/**
 * HTTP request handler for the agent-server.
 * Handles GET /health, GET /readyz, and returns 404 for everything else.
 * Non-GET requests and WebSocket upgrades are not routed here.
 */
export function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  wss: WebSocketServer | null
): void {
  const url = req.url || "/";
  const method = req.method || "GET";

  if (method === "GET" && url === "/health") {
    const body = JSON.stringify(buildHealthResponse(wss));
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(body);
    return;
  }

  if (method === "GET" && url === "/readyz") {
    if (agentsInitialized && !shuttingDown) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ready" }));
    } else {
      const reason = shuttingDown ? "shutting down" : "agents not initialized";
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not ready", reason }));
    }
    return;
  }

  // Everything else: 404 (WebSocket upgrades are handled separately by the WS server)
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

// ============================================================================
// Graceful shutdown with turn draining
// ============================================================================

/**
 * Waits for all active sessions to complete, up to the configured timeout.
 * Returns true if all sessions drained, false if timeout was reached.
 */
export function waitForDrain(config: ShutdownConfig = DEFAULT_SHUTDOWN_CONFIG): Promise<boolean> {
  return new Promise((resolve) => {
    if (activeSessions.size === 0) {
      resolve(true);
      return;
    }

    const deadline = Date.now() + config.drainTimeoutMs;

    const checkInterval = setInterval(() => {
      if (activeSessions.size === 0) {
        clearInterval(checkInterval);
        resolve(true);
        return;
      }

      if (Date.now() >= deadline) {
        clearInterval(checkInterval);
        resolve(false);
        return;
      }
    }, 100);
  });
}

/**
 * Cancels all remaining active sessions using the proper cancellation flow.
 * Tries agent.cancel() first (which sets cancelledByUser, creates checkpoints,
 * and terminates subprocesses), then falls back to direct event emission.
 */
export async function cancelRemainingSessions(): Promise<void> {
  const entries = [...activeSessions];
  for (const [sessionId, agentHarness] of entries) {
    console.log(`[SHUTDOWN] Force-cancelling session ${sessionId} (agent=${agentHarness})`);
    const agent = getAgent(agentHarness as AgentHarness);
    if (agent) {
      try {
        await agent.cancel(sessionId);
      } catch (err) {
        console.error(
          `[SHUTDOWN] agent.cancel() failed for ${sessionId}, emitting events directly:`,
          err
        );
        EventBroadcaster.emitMessageCancelled(sessionId, agentHarness as any);
        EventBroadcaster.emitSessionCancelled(sessionId, agentHarness as any);
      }
    } else {
      EventBroadcaster.emitMessageCancelled(sessionId, agentHarness as any);
      EventBroadcaster.emitSessionCancelled(sessionId, agentHarness as any);
    }
  }
  activeSessions.clear();
}

// ============================================================================
// Reset (for tests)
// ============================================================================

export function resetHealthState(): void {
  agentsInitialized = false;
  shuttingDown = false;
  activeSessions.clear();
}
