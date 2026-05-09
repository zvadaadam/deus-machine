// agent-server/rpc-methods.ts
// JSON-RPC method registration for backend <-> agent-server connections.

import { EventBroadcaster } from "./event-broadcaster";
import { RpcConnection } from "./rpc-connection";
import { classifyError } from "./agents/lifecycle";
import { getAgent, getRegisteredAgentHarnesses } from "./agents/registry";
import type { AgentHarness } from "./protocol";
import type { QueryOptions } from "@shared/protocol";
import { registerAppMcp, unregisterAppMcp } from "./app-registrar";
import { RegisterAppMcpRequestSchema, UnregisterAppMcpRequestSchema } from "./rpc-schemas";
import { isShuttingDown, trackSession, untrackSession } from "./health";

export interface InitializedAgentInfo {
  type: string;
  capabilities: unknown;
  initialized: boolean;
}

export interface RpcMethodContext {
  getInitializedAgents: () => InitializedAgentInfo[];
}

export function registerRpcMethods(rpcTunnel: RpcConnection, ctx: RpcMethodContext): void {
  EventBroadcaster.attachTunnel(rpcTunnel);

  rpcTunnel.addMethod("initialize", () => ({
    version: "1.0",
    agents: ctx.getInitializedAgents(),
  }));

  rpcTunnel.addMethod("initialized", () => {
    console.log("[RPC] Backend handshake complete (initialized)");
    return undefined;
  });

  rpcTunnel.addMethod("turn/start", startTurn);
  rpcTunnel.addMethod("turn/respond", logTurnResponse);
  rpcTunnel.addMethod("turn/cancel", cancelTurnAcrossAgents);
  rpcTunnel.addMethod("session/stop", cancelTurnAcrossAgents);
  rpcTunnel.addMethod("session/reset", resetSessionAcrossAgents);
  rpcTunnel.addMethod("provider/auth", providerAuth);
  rpcTunnel.addMethod("provider/initWorkspace", providerInitWorkspace);
  rpcTunnel.addMethod("provider/contextUsage", providerContextUsage);
  rpcTunnel.addMethod("provider/updateMode", providerUpdateMode);
  rpcTunnel.addMethod("agent/list", () => ({ agents: ctx.getInitializedAgents() }));
  rpcTunnel.addMethod("aap/register-mcp", registerAapMcp);
  rpcTunnel.addMethod("aap/unregister-mcp", unregisterAapMcp);
}

function startTurn(params: unknown): { accepted: boolean; reason?: string } {
  const sessionId = readParam<string>(params, "sessionId");
  const agentHarness = readParam<AgentHarness>(params, "agentHarness");
  const prompt = readParam<string>(params, "prompt");
  const options = readParam<QueryOptions>(params, "options") || ({} as QueryOptions);

  if (isShuttingDown()) {
    return { accepted: false, reason: "shutting down" };
  }

  if (!sessionId || !prompt || !agentHarness) {
    return {
      accepted: false,
      reason: "turn/start requires sessionId, agentHarness, and prompt",
    };
  }

  const agent = getAgent(agentHarness);
  if (!agent) {
    return { accepted: false, reason: `No agent registered for type: ${agentHarness}` };
  }

  trackSession(sessionId, agentHarness);
  EventBroadcaster.emitSessionStarted(sessionId, agentHarness);

  agent
    .query(sessionId, prompt, options)
    .catch((error) => {
      console.error(`[turn/start] Unhandled error in ${agentHarness} query:`, error);
      const classified = classifyError(error);
      EventBroadcaster.emitSessionError(
        sessionId,
        agentHarness,
        classified.message,
        classified.category
      );
    })
    .finally(() => {
      untrackSession(sessionId);
    });

  console.log(`[TIMING][turn/start] DISPATCHED session=${sessionId}`);
  return { accepted: true };
}

function logTurnResponse(params: unknown): void {
  const requestId = readParam<string>(params, "requestId");
  console.log(`[AgentServer] turn/respond received (requestId=${requestId})`);
}

function cancelTurnAcrossAgents(params: unknown): void {
  const sessionId = readParam<string>(params, "sessionId");
  if (!sessionId) return;

  forEachAgent((agent) => {
    void agent.cancel(sessionId);
  });
}

function resetSessionAcrossAgents(params: unknown): void {
  const sessionId = readParam<string>(params, "sessionId");
  if (!sessionId) return;

  forEachAgent((agent) => {
    agent.reset(sessionId);
  });
}

async function providerAuth(params: unknown): Promise<unknown> {
  const agentHarness = requireParam<AgentHarness>(params, "agentHarness", "provider/auth");
  const agent = getAgent(agentHarness);
  if (!agent?.auth) throw new Error(`Agent "${agentHarness}" does not support auth`);
  return agent.auth({ cwd: readParam<string>(params, "cwd") as string });
}

async function providerInitWorkspace(params: unknown): Promise<unknown> {
  const agentHarness = requireParam<AgentHarness>(params, "agentHarness", "provider/initWorkspace");
  const agent = getAgent(agentHarness);
  if (!agent?.initWorkspace) {
    throw new Error(`Agent "${agentHarness}" does not support workspace init`);
  }

  return agent.initWorkspace({
    cwd: readParam<string>(params, "cwd") as string,
    ghToken: readParam<string>(params, "ghToken"),
    providerEnvVars: readParam<string>(params, "providerEnvVars"),
  });
}

async function providerContextUsage(params: unknown): Promise<unknown> {
  const agentHarness = readParam<AgentHarness>(params, "agentHarness");
  const sessionId = readParam<string>(params, "sessionId");
  const cwd = readParam<string>(params, "cwd");
  const agentSessionId = readParam<string>(params, "agentSessionId");

  if (!agentHarness || !sessionId || !cwd || !agentSessionId) {
    throw new Error(
      "provider/contextUsage requires agentHarness, sessionId, cwd, and agentSessionId"
    );
  }

  const agent = getAgent(agentHarness);
  if (!agent?.getContextUsage) {
    throw new Error(`Agent "${agentHarness}" does not support context usage`);
  }

  return agent.getContextUsage({ id: sessionId, options: { cwd, agentSessionId } });
}

function providerUpdateMode(params: unknown): void {
  const agentHarness = requireParam<AgentHarness>(params, "agentHarness", "provider/updateMode");
  const agent = getAgent(agentHarness);

  if (agent?.updatePermissionMode) {
    void agent.updatePermissionMode(
      readParam<string>(params, "sessionId") as string,
      readParam<string>(params, "permissionMode") as string
    );
  }
}

async function registerAapMcp(params: unknown): Promise<{ added: string[] }> {
  const parsed = RegisterAppMcpRequestSchema.parse(params);
  await registerAppMcp(parsed.serverName, parsed.url);
  return { added: [parsed.serverName] };
}

async function unregisterAapMcp(params: unknown): Promise<{ removed: string[] }> {
  const parsed = UnregisterAppMcpRequestSchema.parse(params);
  await unregisterAppMcp(parsed.serverName);
  return { removed: [parsed.serverName] };
}

function forEachAgent(fn: (agent: NonNullable<ReturnType<typeof getAgent>>) => void): void {
  for (const agentHarness of getRegisteredAgentHarnesses()) {
    const agent = getAgent(agentHarness);
    if (agent) fn(agent);
  }
}

function requireParam<T>(params: unknown, key: string, method: string): T {
  const value = readParam<T>(params, key);
  if (!value) throw new Error(`${method} requires ${key}`);
  return value;
}

function readParam<T>(params: unknown, key: string): T | undefined {
  if (!params || typeof params !== "object") return undefined;
  return (params as Record<string, T | undefined>)[key];
}
