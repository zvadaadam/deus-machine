// backend/src/services/agent/commands.ts
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
import { getDatabase } from "../../lib/database";
import { getSessionRaw } from "../../db";
import { writeUserMessage } from "../message-writer";
import { spawnPty, writeToPty, resizePty, killPty } from "../pty.service";
import { watchWorkspace, unwatchWorkspace } from "../fs-watcher.service";
import { delegateToRoute } from "../route-delegate";
import { persistSessionError } from "./persistence";
import { invalidate } from "../query-engine";
import * as agentService from "./service";
import type { CommandName } from "@shared/types/query-protocol";

// ---- Types ----

type QueryParams = Record<string, unknown>;

interface CommandResult {
  commandId?: string;
  [key: string]: unknown;
}

// ---- Command Dispatch ----

export async function runCommand(
  command: CommandName,
  params: QueryParams
): Promise<CommandResult> {
  return (
    match(command)
      .with("sendMessage", () => handleSendMessage(params))
      .with("stopSession", () => handleStopSession(params))
      // ---- PTY commands ----
      .with("pty:spawn", () => {
        const id = readString(params, "id");
        const cmd = readString(params, "command") ?? "bash";
        const args = Array.isArray(params.args) ? (params.args as string[]) : [];
        const cols = readNumber(params, "cols") ?? 80;
        const rows = readNumber(params, "rows") ?? 24;
        const cwd = readString(params, "cwd");
        if (!id) throw new Error("pty:spawn requires id");

        const ptyId = spawnPty({ id, command: cmd, args, cols, rows, cwd });
        return { commandId: ptyId };
      })
      .with("pty:write", () => {
        const id = readString(params, "id");
        if (!id) throw new Error("pty:write requires id");
        const data = Array.isArray(params.data) ? (params.data as number[]) : undefined;
        if (!data) throw new Error("pty:write requires data (number[])");

        writeToPty(id, data);
        return {};
      })
      .with("pty:resize", () => {
        const id = readString(params, "id");
        const cols = readNumber(params, "cols");
        const rows = readNumber(params, "rows");
        if (!id || cols === undefined || rows === undefined) {
          throw new Error("pty:resize requires id, cols, and rows");
        }

        resizePty(id, cols, rows);
        return {};
      })
      .with("pty:kill", () => {
        const id = readString(params, "id");
        if (!id) throw new Error("pty:kill requires id");

        killPty(id);
        return {};
      })
      // ---- File system commands ----
      .with("fs:watch", async () => {
        const workspacePath = readString(params, "workspacePath");
        if (!workspacePath) throw new Error("fs:watch requires workspacePath");

        await watchWorkspace(workspacePath);
        return {};
      })
      .with("fs:unwatch", async () => {
        const workspacePath = readString(params, "workspacePath");
        if (!workspacePath) throw new Error("fs:unwatch requires workspacePath");

        await unwatchWorkspace(workspacePath);
        return {};
      })
      // ---- Git commands ----
      .with("git:clone", async () => {
        const url = readString(params, "url");
        const targetPath = readString(params, "targetPath");
        if (!url || !targetPath) throw new Error("git:clone requires url and targetPath");
        const result = (await delegateToRoute("POST", "/api/repos/clone", {
          url,
          targetPath,
        })) as { success?: boolean; path?: string; error?: string };
        if (result.error) throw new Error(result.error);
        return {};
      })
      .with("git:init", async () => {
        const projectName = readString(params, "projectName");
        const targetPath = readString(params, "targetPath");
        if (!projectName || !targetPath)
          throw new Error("git:init requires projectName and targetPath");
        const templateType = readString(params, "templateType");
        const templateUrl = readString(params, "templateUrl");
        const result = (await delegateToRoute("POST", "/api/repos/init", {
          projectName,
          targetPath,
          ...(templateType ? { template: { type: templateType, url: templateUrl } } : {}),
        })) as { success?: boolean; path?: string; githubUrl?: string; error?: string };
        if (result.error) throw new Error(result.error);
        return { githubUrl: result.githubUrl };
      })
      // ---- Route-delegated commands ----
      .with("createWorkspace", async () => {
        const repositoryId = readString(params, "repository_id");
        if (!repositoryId) throw new Error("createWorkspace requires repository_id");
        const body: Record<string, unknown> = { repository_id: repositoryId };
        const sourceBranch = readString(params, "source_branch");
        const prUrl = readString(params, "pr_url");
        const prTitle = readString(params, "pr_title");
        const targetBranch = readString(params, "target_branch");
        if (sourceBranch) body.source_branch = sourceBranch;
        if (params.pr_number != null) body.pr_number = params.pr_number;
        if (prUrl) body.pr_url = prUrl;
        if (prTitle) body.pr_title = prTitle;
        if (targetBranch) body.target_branch = targetBranch;
        const result = (await delegateToRoute("POST", "/api/workspaces", body)) as { id?: string };
        return { commandId: result.id };
      })
      .with("retrySetup", async () => {
        const workspaceId = readString(params, "workspaceId");
        if (!workspaceId) throw new Error("retrySetup requires workspaceId");
        await delegateToRoute("POST", `/api/workspaces/${workspaceId}/retry-setup`);
        return {};
      })
      .with("openPenFile", async () => {
        const workspaceId = readString(params, "workspaceId");
        const filePath = readString(params, "filePath");
        if (!workspaceId || !filePath)
          throw new Error("openPenFile requires workspaceId and filePath");
        await delegateToRoute("POST", `/api/workspaces/${workspaceId}/open-pen-file`, {
          filePath,
        });
        return {};
      })
      .exhaustive()
  );
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
  invalidate(["workspaces", "sessions", "session", "messages", "stats"], {
    sessionIds: [sessionId],
  });

  // 2. Forward to agent-server (fire-and-forget — ACK already sent)
  const agentType = (readString(params, "agentType") || "claude") as "claude" | "codex";

  // Look up the existing agent_session_id so the SDK resumes the same
  // conversation rather than starting a new one.
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  const existingAgentSessionId = session?.agent_session_id ?? null;

  if (!agentService.isConnected()) {
    handleAgentError(sessionId, agentType, new Error("Agent server is disconnected"));
    return { commandId: result.messageId };
  }

  agentService
    .forwardTurn({
      sessionId,
      agentType,
      prompt: content,
      options: buildTurnOptions(params, model, existingAgentSessionId) as Parameters<
        typeof agentService.forwardTurn
      >[0]["options"],
    })
    .then((response) => {
      if (!response.accepted) {
        handleAgentRejection(sessionId, agentType, response.reason);
      }
    })
    .catch((err) => {
      handleAgentError(sessionId, agentType, err);
    });

  return { commandId: result.messageId };
}

// ---- stopSession ----

async function handleStopSession(params: QueryParams): Promise<CommandResult> {
  const sessionId = readString(params, "sessionId");
  if (!sessionId) throw new Error("stopSession requires sessionId");

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new Error("Session not found");

  if (agentService.isConnected()) {
    try {
      await agentService.stopSession({ sessionId });
    } catch (err) {
      console.error("[CommandHandler] Failed to stop on agent-server:", err);
      // Still mark idle locally — best effort
    }
  }

  db.prepare("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(
    sessionId
  );
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
  return {};
}

// ---- Helpers ----

function buildTurnOptions(
  params: QueryParams,
  model: string | undefined,
  resume: string | null
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
    deusEnv: params.deusEnv as Record<string, string> | undefined,
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

function readNumber(params: QueryParams, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}
