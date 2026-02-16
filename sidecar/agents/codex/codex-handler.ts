// sidecar/agents/codex/codex-handler.ts
// CodexAgentHandler — implements AgentHandler for the OpenAI Codex SDK.
// Mirrors the Claude handler architecture: streaming events, DB persistence,
// frontend notifications via FrontendClient.

// Type-only imports are erased at compile time — safe for CJS bundling.
// The runtime Codex class is loaded via dynamic import() in processQuery()
// because @openai/codex-sdk is ESM-only and uses import.meta.url at module
// init, which can't be shimmed in esbuild's CJS output.
import type { ThreadItem, ThreadOptions } from "@openai/codex-sdk";
import { match, P } from "ts-pattern";
import { FrontendClient } from "../../frontend-client";
import { saveAssistantMessage, updateSessionStatus } from "../../db/session-writer";
import type { AgentHandler, QueryOptions } from "../agent-handler";
import { buildAgentEnvironment } from "../env-builder";
import { initializeCodex, blockIfNotInitialized, getCodexExecutablePath } from "./codex-discovery";
import { resolveCodexModel } from "./codex-models";
import {
  getCodexSession,
  setCodexSession,
  deleteCodexSession,
  abortCodexSession,
  type CodexSessionState,
} from "./codex-session";

// ============================================================================
// Message Format Mapping
// ============================================================================

/**
 * Maps a Codex ThreadItem to Claude-compatible content blocks.
 * The frontend renders messages using Claude's format (TextBlock, ToolUseBlock,
 * ToolResultBlock, ThinkingBlock), so we produce the same shape.
 */
function mapItemToContentBlocks(item: ThreadItem): unknown[] {
  return match(item)
    .with({ type: "agent_message" }, (i) => [{ type: "text", text: i.text }])
    .with({ type: "reasoning" }, (i) => [{ type: "thinking", thinking: i.text }])
    .with({ type: "command_execution" }, (cmd) => {
      const toolUseId = `codex-cmd-${cmd.id}`;
      const blocks: unknown[] = [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: cmd.command },
        },
      ];
      if (cmd.status === "completed" || cmd.status === "failed") {
        blocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: cmd.aggregated_output || `Exit code: ${cmd.exit_code ?? "unknown"}`,
          is_error: cmd.status === "failed" || (cmd.exit_code !== undefined && cmd.exit_code !== 0),
        });
      }
      return blocks;
    })
    .with({ type: "file_change" }, (fc) => {
      const toolUseId = `codex-file-${fc.id}`;
      const summary = fc.changes.map((c) => `${c.kind}: ${c.path}`).join("\n");
      return [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Edit",
          input: {
            file_path: fc.changes[0]?.path ?? "unknown",
            description: summary,
          },
        },
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: summary,
          is_error: fc.status === "failed",
        },
      ];
    })
    .with({ type: "mcp_tool_call" }, (mcp) => {
      const toolUseId = `codex-mcp-${mcp.id}`;
      const blocks: unknown[] = [
        {
          type: "tool_use",
          id: toolUseId,
          name: `${mcp.server}:${mcp.tool}`,
          input: mcp.arguments ?? {},
        },
      ];
      if (mcp.status === "completed" || mcp.status === "failed") {
        blocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: mcp.error?.message ?? JSON.stringify(mcp.result ?? ""),
          is_error: mcp.status === "failed",
        });
      }
      return blocks;
    })
    .with({ type: "web_search" }, (ws) => [
      {
        type: "tool_use",
        id: `codex-ws-${ws.id}`,
        name: "WebSearch",
        input: { query: ws.query },
      },
    ])
    .with({ type: "todo_list" }, (todo) => {
      const text = todo.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n");
      return [{ type: "text", text: `**Plan:**\n${text}` }];
    })
    .with({ type: "error" }, (i) => [{ type: "text", text: `Error: ${i.message}` }])
    .exhaustive();
}

// ============================================================================
// CodexAgentHandler
// ============================================================================

export class CodexAgentHandler implements AgentHandler {
  readonly agentType = "codex" as const;

  initialize(): { success: boolean; error?: string } {
    return initializeCodex();
  }

  async handleQuery(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    console.log("Handling Codex query request for session:", sessionId);
    if (blockIfNotInitialized(sessionId)) return;

    const existingSession = getCodexSession(sessionId);

    // If a query is already running, we can't send a new one (Codex exec is not multi-turn streaming)
    if (existingSession?.isRunning) {
      console.log(`Codex session ${sessionId} already running, aborting previous run`);
      abortCodexSession(sessionId);
    }

    void this.processQuery(sessionId, prompt, options, existingSession?.threadId);
  }

  async handleCancel(sessionId: string): Promise<void> {
    console.log("Handling Codex cancel request for session:", sessionId);
    if (blockIfNotInitialized(sessionId)) return;

    abortCodexSession(sessionId);
    updateSessionStatus(sessionId, "idle");
  }

  handleReset(sessionId: string): void {
    console.log(`Handling reset generator request for Codex session: ${sessionId}`);
    abortCodexSession(sessionId);
    deleteCodexSession(sessionId);
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  private async processQuery(
    sessionId: string,
    prompt: string,
    options: QueryOptions,
    existingThreadId?: string
  ): Promise<void> {
    const queryId = `${sessionId}/${Date.now()}`;
    const abortController = new AbortController();

    const session: CodexSessionState = {
      threadId: existingThreadId,
      abortController,
      currentModel: options.model,
      cwd: options.cwd,
      isRunning: true,
    };
    setCodexSession(sessionId, session);

    try {
      // Build environment (reuse shared env builder)
      const env = buildAgentEnvironment({
        claudeEnvVars: options?.claudeEnvVars,
        hiveEnv: options?.hiveEnv,
        ghToken: options?.ghToken,
      });

      // Extract API key from environment
      const apiKey = env.OPENAI_API_KEY || env.CODEX_API_KEY;
      if (!apiKey) {
        throw new Error(
          "OPENAI_API_KEY or CODEX_API_KEY not found in environment. " +
            "Set it in Settings → Environment Variables."
        );
      }

      const model = resolveCodexModel(options?.model);
      const codexPath = getCodexExecutablePath();

      // Dynamic import — @openai/codex-sdk is ESM-only, can't be require()'d from CJS
      const { Codex } = await import("@openai/codex-sdk");

      // Create Codex instance
      const codex = new Codex({
        apiKey,
        codexPathOverride: codexPath || undefined,
        env,
      });

      // Configure thread options
      const threadOptions: ThreadOptions = {
        model,
        workingDirectory: options?.cwd,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
        additionalDirectories: options?.additionalDirectories,
      };

      // Start or resume thread
      const thread = existingThreadId
        ? codex.resumeThread(existingThreadId, threadOptions)
        : codex.startThread(threadOptions);

      // Run streamed
      const { events } = await thread.runStreamed(prompt, {
        signal: abortController.signal,
      });

      // Accumulate content blocks for the current turn's message
      let turnContentBlocks: unknown[] = [];

      for await (const event of events) {
        if (abortController.signal.aborted) break;

        match(event)
          .with({ type: "thread.started" }, (e) => {
            session.threadId = e.thread_id;
            console.log(`[${queryId}] Thread started: ${e.thread_id}`);
          })
          .with({ type: P.union("item.started", "item.updated", "item.completed") }, (e) => {
            const blocks = mapItemToContentBlocks(e.item);
            if (blocks.length === 0) return;

            // For completed items, accumulate into the turn message
            if (e.type === "item.completed") {
              turnContentBlocks.push(...blocks);
            }

            // Send real-time update to frontend (every event, not just completed)
            FrontendClient.sendMessage({
              id: sessionId,
              type: "message",
              agentType: "codex",
              data: {
                type: "assistant" as const,
                message: {
                  id: `codex-${e.item.id}-${e.type}`,
                  role: "assistant" as const,
                  content: blocks,
                },
              },
            });

            // Persist completed items to database
            if (e.type === "item.completed") {
              saveAssistantMessage(
                sessionId,
                {
                  id: `codex-${e.item.id}`,
                  role: "assistant",
                  content: blocks,
                },
                model
              );
            }
          })
          .with({ type: "turn.completed" }, (e) => {
            console.log(
              `[${queryId}] Turn completed. Tokens: in=${e.usage.input_tokens}, out=${e.usage.output_tokens}`
            );

            FrontendClient.sendMessage({
              id: sessionId,
              type: "message",
              agentType: "codex",
              data: {
                type: "result",
                subtype: "success",
                usage: e.usage,
              },
            });

            updateSessionStatus(sessionId, "idle");
            turnContentBlocks = [];
          })
          .with({ type: "turn.failed" }, (e) => {
            console.error(`[${queryId}] Turn failed:`, e.error.message);
            FrontendClient.sendError({
              id: sessionId,
              type: "error",
              error: e.error.message,
              agentType: "codex",
            });
            updateSessionStatus(sessionId, "error");
          })
          .with({ type: "error" }, (e) => {
            console.error(`[${queryId}] Stream error:`, e.message);
            FrontendClient.sendError({
              id: sessionId,
              type: "error",
              error: e.message,
              agentType: "codex",
            });
            updateSessionStatus(sessionId, "error");
          })
          .with({ type: "turn.started" }, () => {
            // Informational — no action needed
          })
          .exhaustive();
      }

      // Normal completion if turn.completed wasn't received.
      // Only update status if this processQuery still owns the session —
      // a rapid re-query can replace the session before we reach this point.
      const currentSession = getCodexSession(sessionId);
      if (currentSession === session && currentSession.isRunning) {
        updateSessionStatus(sessionId, "idle");
      }

      console.log(`[${queryId}] Codex session completed: ${sessionId}`);
    } catch (error) {
      console.error(`[${queryId}] Error in Codex query:`, error);

      const isAbort =
        error instanceof Error && (error.name === "AbortError" || abortController.signal.aborted);

      // Only update status if this processQuery still owns the session.
      const ownsSession = getCodexSession(sessionId) === session;

      if (!isAbort && ownsSession) {
        FrontendClient.sendError({
          id: sessionId,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
          agentType: "codex",
        });
      }

      if (ownsSession) {
        updateSessionStatus(sessionId, isAbort ? "idle" : "error");
      }
    } finally {
      // Only clean up if this processQuery still owns the session.
      // A rapid re-query can replace the session before this finally runs;
      // blindly mutating would corrupt the new session's state.
      const currentSession = getCodexSession(sessionId);
      if (currentSession === session) {
        currentSession.isRunning = false;
      }
    }
  }
}
