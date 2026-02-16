// sidecar/agents/codex/codex-handler.ts
// CodexAgentHandler — implements AgentHandler for the OpenAI Codex SDK.
// Mirrors the Claude handler architecture: streaming events, DB persistence,
// frontend notifications via FrontendClient.

// Type-only imports are erased at compile time — safe for CJS bundling.
// The runtime Codex class is loaded via dynamic import() in processQuery()
// because @openai/codex-sdk is ESM-only and uses import.meta.url at module
// init, which can't be shimmed in esbuild's CJS output.
import type {
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  AgentMessageItem,
  ReasoningItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  WebSearchItem,
  TodoListItem,
  ErrorItem,
} from "@openai/codex-sdk";
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
  switch (item.type) {
    case "agent_message":
      return [{ type: "text", text: (item as AgentMessageItem).text }];

    case "reasoning":
      return [{ type: "thinking", thinking: (item as ReasoningItem).text }];

    case "command_execution": {
      const cmd = item as CommandExecutionItem;
      const toolUseId = `codex-cmd-${cmd.id}`;
      const blocks: unknown[] = [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: cmd.command },
        },
      ];
      // Add result block if the command has output or has completed
      if (cmd.status === "completed" || cmd.status === "failed") {
        blocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: cmd.aggregated_output || `Exit code: ${cmd.exit_code ?? "unknown"}`,
          is_error: cmd.status === "failed" || (cmd.exit_code !== undefined && cmd.exit_code !== 0),
        });
      }
      return blocks;
    }

    case "file_change": {
      const fc = item as FileChangeItem;
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
    }

    case "mcp_tool_call": {
      const mcp = item as McpToolCallItem;
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
    }

    case "web_search": {
      const ws = item as WebSearchItem;
      return [
        {
          type: "tool_use",
          id: `codex-ws-${ws.id}`,
          name: "WebSearch",
          input: { query: ws.query },
        },
      ];
    }

    case "todo_list": {
      const todo = item as TodoListItem;
      const text = todo.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n");
      return [{ type: "text", text: `**Plan:**\n${text}` }];
    }

    case "error":
      return [{ type: "text", text: `Error: ${(item as ErrorItem).message}` }];

    default:
      return [{ type: "text", text: `[Unknown item type: ${(item as any).type}]` }];
  }
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

        switch (event.type) {
          case "thread.started": {
            // Store the thread ID for resumption
            session.threadId = event.thread_id;
            console.log(`[${queryId}] Thread started: ${event.thread_id}`);
            break;
          }

          case "item.started":
          case "item.updated":
          case "item.completed": {
            const blocks = mapItemToContentBlocks(event.item);
            if (blocks.length === 0) break;

            // For completed items, accumulate into the turn message
            if (event.type === "item.completed") {
              turnContentBlocks.push(...blocks);
            }

            // Send real-time update to frontend (every event, not just completed)
            const messageEnvelope = {
              type: "assistant" as const,
              message: {
                id: `codex-${event.item.id}-${event.type}`,
                role: "assistant" as const,
                content: blocks,
              },
            };

            FrontendClient.sendMessage({
              id: sessionId,
              type: "message",
              agentType: "codex",
              data: messageEnvelope,
            });

            // Persist completed items to database
            if (event.type === "item.completed") {
              saveAssistantMessage(
                sessionId,
                {
                  id: `codex-${event.item.id}`,
                  role: "assistant",
                  content: blocks,
                },
                model
              );
            }
            break;
          }

          case "turn.completed": {
            console.log(
              `[${queryId}] Turn completed. Tokens: in=${event.usage.input_tokens}, out=${event.usage.output_tokens}`
            );

            // Send a result message to signal completion (matches Claude's behavior)
            FrontendClient.sendMessage({
              id: sessionId,
              type: "message",
              agentType: "codex",
              data: {
                type: "result",
                subtype: "success",
                usage: event.usage,
              },
            });

            updateSessionStatus(sessionId, "idle");
            turnContentBlocks = [];
            break;
          }

          case "turn.failed": {
            console.error(`[${queryId}] Turn failed:`, event.error.message);
            FrontendClient.sendError({
              id: sessionId,
              type: "error",
              error: event.error.message,
              agentType: "codex",
            });
            updateSessionStatus(sessionId, "error");
            break;
          }

          case "error": {
            console.error(`[${queryId}] Stream error:`, event.message);
            FrontendClient.sendError({
              id: sessionId,
              type: "error",
              error: event.message,
              agentType: "codex",
            });
            updateSessionStatus(sessionId, "error");
            break;
          }

          case "turn.started":
            // Informational — no action needed
            break;
        }
      }

      // Normal completion if turn.completed wasn't received
      const currentSession = getCodexSession(sessionId);
      if (currentSession?.isRunning) {
        updateSessionStatus(sessionId, "idle");
      }

      console.log(`[${queryId}] Codex session completed: ${sessionId}`);
    } catch (error) {
      console.error(`[${queryId}] Error in Codex query:`, error);

      const isAbort =
        error instanceof Error && (error.name === "AbortError" || abortController.signal.aborted);

      if (!isAbort) {
        FrontendClient.sendError({
          id: sessionId,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
          agentType: "codex",
        });
      }

      updateSessionStatus(sessionId, isAbort ? "idle" : "error");
    } finally {
      const currentSession = getCodexSession(sessionId);
      if (currentSession) {
        currentSession.isRunning = false;
      }
    }
  }
}
