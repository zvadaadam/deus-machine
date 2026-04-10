// agent-server/agents/codex/codex-handler.ts
// CodexAgentHandler — implements AgentHandler for the OpenAI Codex SDK.
// Mirrors the Claude handler architecture: streaming events, canonical event
// emission, and frontend notifications via EventBroadcaster.
// The agent-server is stateless — all DB writes handled by the backend.

// Type-only imports are erased at compile time — safe for CJS bundling.
// The runtime Codex class is loaded via dynamic import() in processQuery()
// because @openai/codex-sdk is ESM-only and uses import.meta.url at module
// init, which can't be shimmed in esbuild's CJS output.
import type { ThreadEvent, ThreadItem, ThreadOptions } from "@openai/codex-sdk";
import { match, P } from "ts-pattern";
import { uuidv7 } from "@shared/lib/uuid";
import { EventBroadcaster } from "../../event-broadcaster";
import { codexSdkAdapter } from "../../messages/codex-sdk-adapter";
import { classifyError, handleCancellation, handleQueryError } from "../lifecycle";
import type { AgentCapabilities, AgentHandler, QueryOptions } from "../registry";
import { buildAgentEnvironment, buildWorkspaceContext } from "../environment";
import { initializeCodex, blockIfNotInitialized, getCodexExecutablePath } from "./codex-discovery";
import { resolveCodexModel } from "./codex-models";
import { codexSessions, abortCodexSession, type CodexSessionState } from "./codex-session";

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
    .otherwise((i) => {
      // External SDK types can gain new variants — gracefully ignore unknown items
      console.warn(`[codex] Unknown ThreadItem type: ${(i as any).type}`);
      return [];
    });
}

// ============================================================================
// CodexAgentHandler
// ============================================================================

export class CodexAgentHandler implements AgentHandler {
  readonly agentType = "codex" as const;
  readonly capabilities: AgentCapabilities = {
    auth: false,
    workspaceInit: false,
    contextUsage: false,
    permissionMode: false,
    modelSwitch: "unsupported",
    multiTurn: false,
    sessionResume: false,
  };

  initialize(): { success: boolean; error?: string } {
    return initializeCodex();
  }

  async query(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    console.log("Handling Codex query request for session:", sessionId);
    if (blockIfNotInitialized(sessionId)) return;

    const existingSession = codexSessions.get(sessionId);

    // If a query is already running, we can't send a new one (Codex exec is not multi-turn streaming)
    if (existingSession?.isRunning) {
      console.log(`Codex session ${sessionId} already running, aborting previous run`);
      abortCodexSession(sessionId);
    }

    void this.processQuery(sessionId, prompt, options, existingSession?.threadId);
  }

  async cancel(sessionId: string): Promise<void> {
    console.log("Handling Codex cancel request for session:", sessionId);
    if (blockIfNotInitialized(sessionId)) return;

    // Signal abort — processQuery's post-loop/catch path owns the
    // status transition via persistCancellation (sets idle + notifies frontend).
    abortCodexSession(sessionId);
  }

  reset(sessionId: string): void {
    console.log(`Handling reset generator request for Codex session: ${sessionId}`);
    abortCodexSession(sessionId);
    codexSessions.delete(sessionId);
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
    codexSessions.set(sessionId, session);

    try {
      // Build environment (reuse shared env builder)
      const env = buildAgentEnvironment({
        providerEnvVars: options?.providerEnvVars,
        deusEnv: options?.deusEnv,
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

      // Inject workspace context via config.developer_instructions
      // so it lands in the system prompt, not the user message.
      const workspaceContext = buildWorkspaceContext(options?.cwd);
      const codex = new Codex({
        apiKey,
        codexPathOverride: codexPath || undefined,
        env,
        ...(workspaceContext ? { config: { developer_instructions: workspaceContext } } : {}),
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

      // Unified Part transformer: runs alongside the legacy event path.
      const messageId = uuidv7();
      const transformer = codexSdkAdapter.createTransformer({ sessionId, messageId });

      for await (const event of events) {
        if (abortController.signal.aborted) break;

        // Dual-write: transform into Parts and emit alongside legacy events
        const parts = transformer.process(event as ThreadEvent);
        EventBroadcaster.emitMessageParts(sessionId, "codex", messageId, parts);

        match(event)
          .with({ type: "thread.started" }, (e) => {
            session.threadId = e.thread_id;
            console.log(`[${queryId}] Thread started: ${e.thread_id}`);
          })
          .with({ type: P.union("item.started", "item.updated", "item.completed") }, (e) => {
            const blocks = mapItemToContentBlocks(e.item);
            if (blocks.length === 0) return;

            // Stable ID per item — same across started/updated/completed phases
            const msgId = `codex-${e.item.id}`;

            // Send real-time update to frontend (every event, not just completed)
            EventBroadcaster.sendMessage({
              id: sessionId,
              type: "message",
              agentType: "codex",
              data: {
                type: "assistant" as const,
                message: {
                  id: msgId,
                  role: "assistant" as const,
                  content: blocks,
                },
              },
            });

            // Only emit canonical event on item.completed to avoid duplicate DB records
            if (e.type === "item.completed") {
              EventBroadcaster.emitAssistantMessage(
                sessionId,
                "codex",
                {
                  id: msgId,
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

            EventBroadcaster.sendMessage({
              id: sessionId,
              type: "message",
              agentType: "codex",
              data: {
                type: "result",
                subtype: "success",
                usage: e.usage,
              },
            });

            // Emit canonical events — backend handles DB status update
            EventBroadcaster.emitMessageResult(sessionId, "codex", "success", e.usage);
            EventBroadcaster.emitSessionIdle(sessionId, "codex");
          })
          .with({ type: "turn.failed" }, (e) => {
            const classified = classifyError(e.error);
            console.error(`[${queryId}] Turn failed [${classified.category}]:`, classified.message);
            handleQueryError(sessionId, "codex", e.error);
          })
          .with({ type: "error" }, (e) => {
            const classified = classifyError(e);
            console.error(
              `[${queryId}] Stream error [${classified.category}]:`,
              classified.message
            );
            handleQueryError(sessionId, "codex", e);
          })
          .with({ type: "turn.started" }, () => {
            // Informational — no action needed
          })
          .otherwise((e) => {
            // External SDK types can gain new variants — gracefully skip unknown events
            console.warn(`[codex] Unknown ThreadEvent type: ${(e as any).type}`);
          });
      }

      // Finalize the transformer: close open parts, emit usage
      const finished = transformer.finish();
      EventBroadcaster.emitMessagePartsFinished(
        sessionId,
        "codex",
        messageId,
        finished.usage,
        undefined,
        finished.finishReason
      );

      // Only update status if this processQuery still owns the session —
      // a rapid re-query can replace the session before we reach this point.
      if (codexSessions.owns(sessionId, session)) {
        if (abortController.signal.aborted) {
          // Abort break path: notify frontend + emit canonical events
          handleCancellation(sessionId, "codex", resolveCodexModel(options?.model), true);
        }
        // Note: no fallback idle emission here — turn.completed already emits it.
        // Emitting again would give the backend duplicate terminal lifecycle events.
      }

      console.log(`[${queryId}] Codex session completed: ${sessionId}`);
    } catch (error) {
      const raw = classifyError(error);
      // Also treat abortController.signal.aborted as abort (codex-specific:
      // the error itself might not say "abort" but the signal was triggered)
      const isAbort = raw.category === "abort" || abortController.signal.aborted;
      console.error(
        `[${queryId}] Error in Codex query [${isAbort ? "abort" : raw.category}]:`,
        raw.message
      );

      // Only update status if this processQuery still owns the session.
      if (codexSessions.owns(sessionId, session)) {
        if (isAbort) {
          handleCancellation(sessionId, "codex", resolveCodexModel(options?.model), true);
        } else {
          handleQueryError(sessionId, "codex", error);
        }
      }
    } finally {
      // Only clean up if this processQuery still owns the session.
      // A rapid re-query can replace the session before this finally runs;
      // blindly mutating would corrupt the new session's state.
      if (codexSessions.owns(sessionId, session)) {
        session.isRunning = false;
      }
    }
  }
}
