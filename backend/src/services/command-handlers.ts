// backend/src/services/command-handlers.ts
// Business logic for q:command dispatch.
//
// Each command handler is a focused function that:
//   1. Validates and extracts typed params
//   2. Performs DB writes
//   3. Triggers subscription invalidation
//   4. Forwards to agent-server when needed
//
// The query engine (protocol layer) delegates here — it should never
// contain business logic directly.

import { match } from "ts-pattern";
import { getDatabase } from "../lib/database";
import { getSessionRaw } from "../db";
import { writeUserMessage } from "./message-writer";
import { persistSessionError } from "./agent-persistence";
import { invalidate } from "./query-engine";
import type { CommandName } from "../../../shared/types/query-protocol";

// ---- Types ----

type QueryParams = Record<string, unknown>;

interface CommandResult {
  commandId?: string;
}

type ForwardToAgentFn = (params: {
  sessionId: string;
  agentType: string;
  prompt: string;
  options: Record<string, unknown>;
}) => Promise<{ accepted: boolean; reason?: string }>;

type CancelAgentFn = (params: { sessionId: string }) => Promise<void>;

// ---- Agent Forwarding (set from server.ts) ----

let forwardToAgent: ForwardToAgentFn | null = null;
let cancelAgent: CancelAgentFn | null = null;

export function setAgentForwarder(forward: ForwardToAgentFn, cancel: CancelAgentFn): void {
  forwardToAgent = forward;
  cancelAgent = cancel;
}

// ---- Command Dispatch ----

export function runCommand(command: CommandName, params: QueryParams): CommandResult {
  return match(command)
    .with("sendMessage", () => handleSendMessage(params))
    .with("stopSession", () => handleStopSession(params))
    .exhaustive();
}

// ---- sendMessage ----

function handleSendMessage(params: QueryParams): CommandResult {
  const sessionId = readString(params, "sessionId");
  const content = readString(params, "content");
  const model = readString(params, "model");
  if (!sessionId || !content) {
    throw new Error("sendMessage requires sessionId and content");
  }

  // 1. Persist the user message
  const result = writeUserMessage(sessionId, content, model);
  if (!result.success) throw new Error(result.error);
  invalidate(["workspaces", "sessions", "session", "messages", "stats"], { sessionIds: [sessionId] });

  // 2. Forward to agent-server (fire-and-forget — ACK already sent)
  if (forwardToAgent) {
    const agentType = readString(params, "agentType") || "claude";

    // Look up the existing agent_session_id so the SDK resumes the same
    // conversation rather than starting a new one.
    const db = getDatabase();
    const session = getSessionRaw(db, sessionId);
    const existingAgentSessionId = session?.agent_session_id ?? null;

    forwardToAgent({
      sessionId,
      agentType,
      prompt: content,
      options: buildTurnOptions(params, model, existingAgentSessionId),
    }).then((response) => {
      if (!response.accepted) {
        handleAgentRejection(sessionId, agentType, response.reason);
      }
    }).catch((err) => {
      handleAgentError(sessionId, agentType, err);
    });
  }

  return { commandId: result.messageId };
}

// ---- stopSession ----

function handleStopSession(params: QueryParams): CommandResult {
  const sessionId = readString(params, "sessionId");
  if (!sessionId) throw new Error("stopSession requires sessionId");

  if (cancelAgent) {
    cancelAgent({ sessionId }).catch((err) => {
      console.error("[CommandHandler] Failed to cancel on agent-server:", err);
    });
  }

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new Error("Session not found");

  db.prepare("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(sessionId);
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
  return {};
}

// ---- Helpers ----

function buildTurnOptions(
  params: QueryParams,
  model: string | undefined,
  resume: string | null,
): Record<string, unknown> {
  return {
    cwd: readString(params, "cwd") || "",
    model,
    maxThinkingTokens: params.maxThinkingTokens as number | undefined,
    maxTurns: params.maxTurns as number | undefined,
    turnId: readString(params, "turnId"),
    permissionMode: readString(params, "permissionMode"),
    providerEnvVars: readString(params, "providerEnvVars"),
    ghToken: readString(params, "ghToken"),
    opendevsEnv: params.opendevsEnv as Record<string, string> | undefined,
    additionalDirectories: params.additionalDirectories as string[] | undefined,
    chromeEnabled: params.chromeEnabled as boolean | undefined,
    strictDataPrivacy: params.strictDataPrivacy as boolean | undefined,
    shouldResetGenerator: params.shouldResetGenerator as boolean | undefined,
    resume: resume || readString(params, "resume"),
    resumeSessionAt: readString(params, "resumeSessionAt"),
  };
}

function handleAgentRejection(sessionId: string, agentType: string, reason?: string): void {
  const msg = reason || "Agent rejected the message";
  console.error(`[CommandHandler] Agent rejected sendMessage for session=${sessionId}: ${msg}`);
  persistSessionError({
    type: "session.error",
    sessionId,
    agentType: agentType as "claude",
    error: msg,
    category: "internal",
  });
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
}

function handleAgentError(sessionId: string, agentType: string, err: unknown): void {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("[CommandHandler] Failed to forward to agent-server:", errorMsg);
  persistSessionError({
    type: "session.error",
    sessionId,
    agentType: agentType as "claude",
    error: `Agent server communication failed: ${errorMsg}`,
    category: "internal",
  });
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
}

function readString(params: QueryParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}
