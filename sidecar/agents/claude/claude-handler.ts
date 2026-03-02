// sidecar/agents/claude/claude-handler.ts
// ClaudeAgentHandler — implements AgentHandler for the Claude Agent SDK.
// Orchestrates the generator lifecycle, delegates to focused modules.

import { query as claudeSDK } from "@anthropic-ai/claude-agent-sdk";
import { FrontendClient } from "../../frontend-client";
import { classifyError, classifyStopReason } from "../error-classifier";
import { createCheckpoint } from "./checkpoint";
import {
  saveAssistantMessage,
  saveToolResultMessage,
  updateSessionStatus,
  saveAgentSessionId,
  lookupAgentSessionId,
} from "../../db/session-writer";
import type { AgentHandler, QueryOptions } from "../agent-handler";
import { buildAgentEnvironment, parseEnvString } from "../env-builder";
import {
  initializeClaude,
  blockIfNotInitialized,
  getClaudeExecutablePath,
} from "./claude-discovery";
import { mapModelForProvider } from "./claude-models";
import { buildSdkOptions, DEFAULT_PROMPT, DEFAULT_SETTING_SOURCES } from "./claude-sdk-options";
import {
  getSession,
  setSession,
  deleteSession,
  getQuery,
  setQuery,
  deleteQuery,
  settingsChanged,
  terminateSession,
  isSessionActive,
  type SessionState,
} from "./claude-session";

// Re-export parseEnvString for backwards compatibility
export { parseEnvString } from "../env-builder";

// Re-export for index.ts backwards compatibility during transition
export {
  initializeClaude as initializeClaudeHandler,
  blockIfNotInitialized,
} from "./claude-discovery";

// ============================================================================
// Helpers
// ============================================================================

function safeStringify(obj: unknown, indent?: number): string {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    },
    indent
  );
}

// ============================================================================
// RPC parameter types
// ============================================================================

interface ClaudeAuthParams {
  id: string;
  cwd: string;
}

interface WorkspaceInitParams {
  id: string;
  cwd: string;
  ghToken?: string;
  claudeEnvVars?: string;
}

interface ContextUsageRequest {
  id: string;
  options: { cwd: string; claudeSessionId: string };
}

interface WorkspaceInitOptions {
  cwd: string;
  ghToken?: string;
  claudeEnvVars?: string;
}

// ============================================================================
// ClaudeAgentHandler
// ============================================================================

export class ClaudeAgentHandler implements AgentHandler {
  readonly agentType = "claude" as const;

  initialize(): { success: boolean; error?: string } {
    return initializeClaude();
  }

  async handleQuery(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    const tHandleQuery = Date.now();
    console.log(`[TIMING][handleQuery] START session=${sessionId} prompt=${prompt.slice(0, 80)}...`);
    if (blockIfNotInitialized(sessionId)) return;

    const session = getSession(sessionId);
    const modelChanged = session?.currentModel !== options.model;
    const maxThinkingTokensChanged =
      session?.currentMaxThinkingTokens !== options.maxThinkingTokens;
    const settingsChangedFlag = settingsChanged(session?.currentSettings, options);

    if (session) {
      session.turnId = options.turnId;
      session.cwd = options.cwd;
    }

    const canReuse =
      isSessionActive(session) && options.shouldResetGenerator !== true && !settingsChangedFlag;

    if (canReuse) {
      console.log(`[TIMING][handleQuery] REUSE session=${sessionId} decisionTime=${Date.now() - tHandleQuery}ms`);

      // Hot-swap model if it changed
      if (modelChanged && session) {
        const query = getQuery(sessionId);
        if (query) {
          const envVars = options.claudeEnvVars ? parseEnvString(options.claudeEnvVars) : {};
          const mappedModel = mapModelForProvider(options.model, envVars);
          console.log(
            `Model changed from ${session.currentModel} to ${options.model}, using setModel callback`
          );
          try {
            await query.setModel(mappedModel);
            const updatedSession = getSession(sessionId);
            if (updatedSession) updatedSession.currentModel = options.model;
          } catch (error) {
            console.error(
              `Failed to update model: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      // Hot-swap maxThinkingTokens if it changed
      const query = getQuery(sessionId);
      if (maxThinkingTokensChanged && session && query) {
        try {
          await query.setMaxThinkingTokens(options.maxThinkingTokens ?? null);
          session!.currentMaxThinkingTokens = options.maxThinkingTokens;
        } catch (error) {
          console.error(
            `Failed to update maxThinkingTokens: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Update permission mode if provided
      if (query && options.permissionMode) {
        try {
          await query.setPermissionMode(options.permissionMode);
        } catch (error) {
          console.error(
            `Failed to update permission mode: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Push the new prompt into the existing generator
      // isSessionActive type guard narrows sendMessage to be defined
      session.sendMessage(prompt);
    } else {
      const reason = !session
        ? "new session"
        : !isSessionActive(session)
          ? "no active generator"
          : options.shouldResetGenerator
            ? "should reset generator"
            : "settings changed";
      console.log(`[TIMING][handleQuery] NEW_GENERATOR session=${sessionId} reason="${reason}" decisionTime=${Date.now() - tHandleQuery}ms`);

      if (isSessionActive(session)) {
        terminateSession(sessionId);
      }

      const newSession: SessionState = {
        currentSettings: {
          claudeEnvVars: options.claudeEnvVars,
          additionalDirectories: options.additionalDirectories,
          chromeEnabled: options.chromeEnabled,
          strictDataPrivacy: options.strictDataPrivacy,
        },
        currentModel: options.model,
        currentMaxThinkingTokens: options.maxThinkingTokens,
        turnId: options.turnId,
        cwd: options.cwd,
      };
      setSession(sessionId, newSession);

      void this.processWithGenerator(sessionId, prompt, options);
    }
  }

  async handleCancel(sessionId: string): Promise<void> {
    console.log("Handling Claude cancel request for session:", sessionId);
    if (blockIfNotInitialized(sessionId)) return;

    const query = getQuery(sessionId);
    const session = getSession(sessionId);

    if (isSessionActive(session) && query) {
      console.log(`Force-closing query for session ${sessionId}`);

      // 1. Flag cancellation so the post-loop path persists the cancelled message
      session.cancelledByUser = true;

      // 2. Create checkpoint before process dies
      if (session.turnId && session.cwd) {
        createCheckpoint(sessionId, session.turnId, "end", session.cwd, "claudeHandler");
      }

      // 3. Force kill: close() terminates CLI subprocess + all children + MCP transports
      query.close();

      // 4. Signal prompt generator to stop — finally block owns cleanup
      terminateSession(sessionId);
    } else {
      console.log(`No active session found for ${sessionId} to cancel`);
    }
  }

  handleReset(sessionId: string): void {
    console.log(`Handling reset generator request for session: ${sessionId}`);
    const session = getSession(sessionId);
    if (session) {
      console.log(`Terminating generator for session ${sessionId} on reset request`);
      terminateSession(sessionId);
    }
  }

  // ==========================================================================
  // Claude-specific RPC methods (not part of AgentHandler interface)
  // ==========================================================================

  async claudeAuth(params: ClaudeAuthParams) {
    const { accountInfo, error } = await this.getClaudeAccountInfo(params.cwd);
    return {
      id: params.id,
      type: "claude_auth_output",
      agentType: "claude",
      accountInfo,
      error,
    };
  }

  async workspaceInit(params: WorkspaceInitParams) {
    const { slashCommands, mcpServers, error } = await this.getClaudeWorkspaceInitData({
      cwd: params.cwd,
      ghToken: params.ghToken,
      claudeEnvVars: params.claudeEnvVars,
    });
    return {
      id: params.id,
      type: "workspace_init_output",
      agentType: "claude",
      slashCommands,
      mcpServers,
      error,
    };
  }

  async updatePermissionMode(sessionId: string, permissionMode: string): Promise<void> {
    console.log(`Handling permission mode update for session ${sessionId}: ${permissionMode}`);
    const session = getSession(sessionId);
    const existingQuery = getQuery(sessionId);

    if (!session) {
      console.log(`No active session found for ${sessionId}, ignoring permission mode update`);
      return;
    }

    if (existingQuery) {
      try {
        await existingQuery.setPermissionMode(permissionMode);
        console.log(`Permission mode updated to ${permissionMode} for session ${sessionId}`);
      } catch (error) {
        console.error(
          `Failed to update permission mode: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  async getContextUsage(request: ContextUsageRequest) {
    const { id: sessionId, options } = request;
    const claudeSessionId = options.claudeSessionId;

    console.log(
      `[getContextUsage] Getting context usage for session: ${sessionId}, claudeSessionId: ${claudeSessionId}`
    );

    if (!claudeSessionId) throw new Error("No claudeSessionId provided");
    if (blockIfNotInitialized(sessionId)) throw new Error("Initialization failure");

    const sdkOptions = {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: getClaudeExecutablePath(),
      systemPrompt: DEFAULT_PROMPT,
      settingSources: DEFAULT_SETTING_SOURCES,
      resume: claudeSessionId,
    };

    const contextUsageQuery = claudeSDK({ prompt: "/context", options: sdkOptions });

    try {
      for await (const message of contextUsageQuery) {
        if (message.type !== "user") continue;
        return {
          type: "context_usage",
          id: sessionId,
          agentType: "claude",
          contextUsageData: message,
        };
      }
    } finally {
      try {
        await contextUsageQuery.interrupt();
      } catch (error) {
        console.error(`[getContextUsage] Error during interrupt:`, error);
      }
    }

    throw new Error("No user message found in context usage response");
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  private async getClaudeAccountInfo(cwd: string) {
    const emptyPromptInput = (async function* () {})();
    const sdkOptions = {
      cwd,
      pathToClaudeCodeExecutable: getClaudeExecutablePath(),
      systemPrompt: DEFAULT_PROMPT,
    };
    const queryResult = claudeSDK({
      prompt: emptyPromptInput,
      options: sdkOptions,
    });
    try {
      const accountInfo = await queryResult.accountInfo();
      return { accountInfo };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      void queryResult.interrupt().catch((error: Error) => {
        console.error(`[getClaudeAccountInfo] Error during interrupt:`, error);
      });
    }
  }

  private async getClaudeWorkspaceInitData(options: WorkspaceInitOptions) {
    const envForClaude = buildAgentEnvironment({
      claudeEnvVars: options.claudeEnvVars,
      ghToken: options.ghToken,
    });

    const emptyPromptInput = (async function* () {})();
    const sdkOptions = {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: getClaudeExecutablePath(),
      systemPrompt: DEFAULT_PROMPT,
      settingSources: DEFAULT_SETTING_SOURCES,
      env: envForClaude,
    };

    const queryResult = claudeSDK({ prompt: emptyPromptInput, options: sdkOptions });
    try {
      const [slashCommands, mcpServers] = await Promise.all([
        queryResult.supportedCommands(),
        queryResult.mcpServerStatus(),
      ]);

      return { slashCommands, mcpServers };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      void queryResult.interrupt().catch((error: Error) => {
        console.error(`[getClaudeWorkspaceInitData] Error during interrupt:`, error);
      });
    }
  }

  /**
   * Creates an async-generator-backed Claude SDK session.
   * Uses a message queue for multi-turn conversations.
   */
  private async processWithGenerator(
    sessionId: string,
    initialPrompt: string,
    options: QueryOptions
  ): Promise<void> {
    const tProcessStart = Date.now();
    const generatorId = `${sessionId}/${tProcessStart}`;
    const session = getSession(sessionId);
    if (!session) {
      console.error(`[${generatorId}] Session ${sessionId} not found`);
      return;
    }
    console.log(`[TIMING][${generatorId}] processWithGenerator START`);

    // --- Message queue for multi-turn conversations ---
    const messageQueue: string[] = [initialPrompt];
    let waitingForMessage: ((msg: string) => void) | null = null;
    let asyncIterableTerminated = false;

    session.sendMessage = (message: string) => {
      console.log(`[${generatorId}] Pushing message to queue`);
      messageQueue.push(message);
      if (waitingForMessage) {
        const resolver = waitingForMessage;
        waitingForMessage = null;
        resolver(messageQueue.shift()!);
      }
    };

    session.sendTerminate = () => {
      console.log(`[${generatorId}] Sending terminate signal`);
      asyncIterableTerminated = true;
      if (waitingForMessage) {
        const resolver = waitingForMessage;
        waitingForMessage = null;
        resolver("");
      }
    };

    // Track whether the current query completed successfully (received result/success).
    // The SDK subprocess may exit with a signal (e.g. SIGINT) after finishing — the
    // CLI binary's normal shutdown mechanism. The SDK reports ANY signal-based exit as
    // an error, even when the query already succeeded. This flag lets the catch block
    // distinguish "process cleanup after success" from genuine mid-query failures.
    let querySucceeded = false;

    // Track whether classifyStopReason detected an error (e.g. max_tokens).
    // When set, prevents the result/success and post-loop idle writes from
    // overwriting the error status — the SDK always emits result/success even
    // after max_tokens, so without this guard the error would be clobbered.
    let stopReasonError = false;

    try {
      // Build environment using shared env-builder
      const tEnvStart = Date.now();
      const envForClaude = buildAgentEnvironment({
        claudeEnvVars: options?.claudeEnvVars,
        opendevsEnv: options?.opendevsEnv,
        ghToken: options?.ghToken,
        extraEnv: { CLAUDE_CODE_ENABLE_TASKS: "true" },
      });
      console.log(`[TIMING][${generatorId}] buildAgentEnvironment took ${Date.now() - tEnvStart}ms`);

      // Auto-inject resume for session continuity after sidecar restart.
      // If no explicit resume was provided and a previous agent_session_id
      // exists in the DB, inject it so the SDK resumes the conversation
      // with full context (message history, tool state).
      // Skip when shouldResetGenerator is true — the user explicitly wants a clean start.
      const tResumeStart = Date.now();
      if (!options.resume && !options.shouldResetGenerator) {
        const savedAgentSessionId = lookupAgentSessionId(sessionId);
        if (savedAgentSessionId) {
          console.log(
            `[${generatorId}] Auto-resuming session with agent_session_id ${savedAgentSessionId}`
          );
          options = { ...options, resume: savedAgentSessionId };
        }
      }
      console.log(`[TIMING][${generatorId}] resumeLookup took ${Date.now() - tResumeStart}ms resume=${!!options.resume} resumeId=${options.resume ?? "none"}`);
      if (options.resume) {
        console.log(`[RESUME-DEBUG][${generatorId}] Attempting resume with agent_session_id=${options.resume} for session=${sessionId}`);
      }

      // Build SDK options using the dedicated builder
      const tSdkOptsStart = Date.now();
      const sdkOptions = buildSdkOptions(sessionId, envForClaude, options);
      console.log(`[TIMING][${generatorId}] buildSdkOptions took ${Date.now() - tSdkOptsStart}ms`);

      // Build the async-iterable prompt source
      const promptInput = (async function* () {
        while (true) {
          let message: string | undefined;
          if (messageQueue.length > 0) {
            message = messageQueue.shift();
          } else {
            message = await new Promise<string>((resolve) => {
              waitingForMessage = resolve;
            });
          }

          if (asyncIterableTerminated) break;

          // Content can be plain text or a JSON-stringified content blocks array
          // (when user attaches images). Parse to pass as MessageParam.content array
          // so the SDK sends image blocks to Claude's vision API.
          let content: string | unknown[] = message as string;
          if (message && message.startsWith("[")) {
            try {
              const parsed = JSON.parse(message);
              if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
                content = parsed;
              }
            } catch {
              // Not valid JSON — keep as plain text string
            }
          }

          yield {
            type: "user" as const,
            message: { role: "user" as const, content },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        }
      })();

      // Start the SDK query
      console.log(`[TIMING][${generatorId}] SDK spawn starting (elapsed since processStart: ${Date.now() - tProcessStart}ms)`);
      console.log(`[RESUME-DEBUG][${generatorId}] SDK options: resume=${sdkOptions.resume ?? "none"} cwd=${sdkOptions.cwd} model=${sdkOptions.model} permissionMode=${sdkOptions.permissionMode}`);
      const tSdkSpawn = Date.now();
      const queryResult = claudeSDK({ prompt: promptInput, options: sdkOptions });
      console.log(`[TIMING][${generatorId}] claudeSDK() constructor returned in ${Date.now() - tSdkSpawn}ms`);

      setQuery(sessionId, queryResult);
      session.generator = queryResult[Symbol.asyncIterator]();

      // Stream messages back to the frontend and persist to DB.
      // IMPORTANT: Persist to DB BEFORE notifying frontend, so messages
      // are in the DB when the frontend receives the event and fetches them.
      let messageCount = 0;
      let firstMessageTime: number | null = null;
      const tStreamStart = Date.now();
      for await (const message of queryResult) {
        messageCount++;
        if (firstMessageTime === null) {
          firstMessageTime = Date.now();
          console.log(`[TIMING][${generatorId}] FIRST_MESSAGE received after ${firstMessageTime - tSdkSpawn}ms (type=${(message as any)?.type})`);
        }
        if (message) {
          let cleanMessage: Record<string, unknown>;
          try {
            const messageStr = safeStringify(message);
            cleanMessage = JSON.parse(messageStr);
          } catch (parseError) {
            console.error(
              `[${generatorId}] Failed to serialize/parse SDK message, skipping:`,
              parseError instanceof Error ? parseError.message : String(parseError)
            );
            continue;
          }

          // One-shot: capture SDK session_id on the first message.
          // Every SDK message carries session_id. We persist it once so
          // the sidecar can resume this conversation after a restart.
          if (!session.agentSessionIdCaptured && cleanMessage.session_id) {
            const agentSessionId = String(cleanMessage.session_id);
            const saveResult = saveAgentSessionId(sessionId, agentSessionId);
            if (saveResult.ok) {
              session.agentSessionIdCaptured = true;
              console.log(`[${generatorId}] Captured agent_session_id: ${agentSessionId}`);
            } else {
              console.error(
                `[${generatorId}] Failed to persist agent_session_id: ${saveResult.error}`
              );
            }
          }

          // Extract common fields from the deserialized SDK message.
          // cleanMessage is Record<string, unknown> (JSON.parse output), so
          // we narrow once here instead of scattering `as` casts at each call site.
          const msg = cleanMessage.message as
            | { id?: string; role?: string; content?: unknown; stop_reason?: string }
            | undefined;
          const parentToolUseId =
            typeof cleanMessage.parent_tool_use_id === "string"
              ? cleanMessage.parent_tool_use_id
              : null;

          // Persist assistant messages to database (before frontend notification)
          if (cleanMessage.type === "assistant" && msg) {
            const model = options?.model || "opus";
            const tDbWrite = Date.now();
            const writeResult = saveAssistantMessage(sessionId, msg, model, parentToolUseId);
            const dbWriteMs = Date.now() - tDbWrite;
            if (!writeResult.ok) {
              console.error(
                `[${generatorId}] DB write failed for assistant message: ${writeResult.error}`
              );
            }
            if (dbWriteMs > 10) {
              console.log(`[TIMING][${generatorId}] saveAssistantMessage took ${dbWriteMs}ms`);
            }
          }

          // Persist user messages with tool_result blocks so the frontend
          // can link tool_use → tool_result via the toolResultMap
          if (cleanMessage.type === "user" && msg) {
            const content = msg.content;
            const hasToolResult =
              Array.isArray(content) && content.some((b: any) => b?.type === "tool_result");
            if (hasToolResult) {
              const tDbWrite = Date.now();
              const writeResult = saveToolResultMessage(sessionId, msg, parentToolUseId);
              const dbWriteMs = Date.now() - tDbWrite;
              if (!writeResult.ok) {
                console.error(
                  `[${generatorId}] DB write failed for tool_result message: ${writeResult.error}`
                );
              }
              if (dbWriteMs > 10) {
                console.log(`[TIMING][${generatorId}] saveToolResultMessage took ${dbWriteMs}ms`);
              }
            }
          }

          // Send to frontend via JSON-RPC notification (after DB write)
          const tSend = Date.now();
          FrontendClient.sendMessage({
            id: sessionId,
            type: "message",
            agentType: "claude",
            data: cleanMessage,
          });
          const sendMs = Date.now() - tSend;
          if (sendMs > 5) {
            console.log(`[TIMING][${generatorId}] sendMessage took ${sendMs}ms`);
          }

          // Log per-message timing for first 5 messages, then every 10th
          if (messageCount <= 5 || messageCount % 10 === 0) {
            console.log(`[TIMING][${generatorId}] msg#${messageCount} type=${cleanMessage.type}${cleanMessage.type === "result" ? "/" + cleanMessage.subtype : ""} elapsed=${Date.now() - tStreamStart}ms`);
          }

          // Check if stop_reason indicates an error condition (e.g. max_tokens).
          // Fires AFTER sendMessage so the truncated content lands in the
          // frontend cache before the error banner appears.
          if (cleanMessage.type === "assistant" && msg) {
            const stopError = classifyStopReason(msg.stop_reason);
            if (stopError) {
              FrontendClient.sendError({
                id: sessionId,
                type: "error",
                error: stopError.message,
                agentType: "claude",
                category: stopError.category,
              });
              updateSessionStatus(sessionId, "error", stopError.message, stopError.category);
              stopReasonError = true;
            }
          }

          // Update session status when query completes successfully.
          // Skip if a stop-reason error was already recorded (e.g. max_tokens) —
          // the SDK emits result/success even after truncation.
          if (cleanMessage.type === "result" && cleanMessage.subtype === "success") {
            querySucceeded = true;
            if (!stopReasonError) {
              updateSessionStatus(sessionId, "idle");
            }
          }
        }
      }

      console.log(`[TIMING][${generatorId}] STREAM_COMPLETE messages=${messageCount} totalStreamTime=${Date.now() - tStreamStart}ms totalProcessTime=${Date.now() - tProcessStart}ms`);

      // User-initiated cancellation: close() killed the process, for-await exited normally.
      // Persist the cancelled message so AssistantTurn.tsx renders "Turn interrupted".
      if (session.cancelledByUser) {
        const model = options?.model || "opus";
        saveAssistantMessage(
          sessionId,
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stop_reason: "cancelled",
          },
          model
        );

        FrontendClient.sendMessage({
          id: sessionId,
          type: "message",
          agentType: "claude",
          data: { type: "cancelled" },
        });

        updateSessionStatus(sessionId, "idle");
        console.log(`[${generatorId}] Session cancelled by user: ${sessionId}`);
        return;
      }

      // Normal completion — ensure session is marked idle
      // (covers the case where SDK ends without a "result/success" message).
      // Skip if a stop-reason error was already recorded — preserve error state.
      if (!stopReasonError) {
        updateSessionStatus(sessionId, "idle");
      }
      console.log(`[${generatorId}] Session completed: ${sessionId}`);
    } catch (error) {
      // User-initiated cancellation: close() killed the subprocess, which may cause
      // the for-await to throw instead of exiting cleanly (SDK-dependent behavior).
      // If we land here, the post-loop path (above) was never reached, so we must
      // persist the cancelled message ourselves. If the post-loop path DID run and
      // then close() threw asynchronously, we never reach this catch (return on line 653).
      if (session.cancelledByUser) {
        const model = options?.model || "opus";
        saveAssistantMessage(
          sessionId,
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stop_reason: "cancelled",
          },
          model
        );

        FrontendClient.sendMessage({
          id: sessionId,
          type: "message",
          agentType: "claude",
          data: { type: "cancelled" },
        });

        updateSessionStatus(sessionId, "idle");
        console.log(`[${generatorId}] Session cancelled by user (catch path): ${sessionId}`);
        return;
      }

      // The SDK subprocess may exit with a signal (e.g. SIGINT) after the query
      // already completed successfully. This happens because the CLI binary shuts
      // down its process between turns, and the SDK reports any signal-based exit
      // as an error via inputStream.error(). If result/success was already received,
      // this is expected process cleanup — not a real error.
      if (querySucceeded) {
        if (!stopReasonError) {
          updateSessionStatus(sessionId, "idle");
        }
        console.log(`[${generatorId}] Process exited after successful query (expected cleanup)`);
        return;
      }

      const classified = classifyError(error);
      const rawErrorMsg = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : "non-Error";
      const errorStack = error instanceof Error ? error.stack?.split("\n").slice(0, 5).join("\n") : "no stack";
      // Extract any extra properties the SDK may attach (cause, code, exitCode, signal, etc.)
      const extraProps = error instanceof Error
        ? Object.getOwnPropertyNames(error)
            .filter((k) => !["message", "stack", "name"].includes(k))
            .map((k) => `${k}=${JSON.stringify((error as any)[k])}`)
            .join(" ")
        : "";
      console.error(
        `[${generatorId}] Error in Claude query [${classified.category}]:`,
        classified.message
      );
      console.error(
        `[${generatorId}] Error details:`,
        `name=${errorName}`,
        `wasResume=${!!options.resume}`,
        `resumeId=${options.resume ?? "none"}`,
        `querySucceeded=${querySucceeded}`,
        `messageCount=${messageCount}`,
        extraProps ? `extraProps={${extraProps}}` : "extraProps={}",
      );
      console.error(`[${generatorId}] Stack (top 5):\n${errorStack}`);

      // Resume failures are handled by the normal error path below.
      // The agent_session_id is preserved in the DB so the next retry
      // re-attempts the same session. The classified error (network,
      // auth, rate_limit, context_limit, etc.) flows through to the
      // frontend which already renders the correct UI for each category.

      // Only act on this error if this generator still owns the session.
      // A rapid re-query can replace the session before the catch runs;
      // writing stale cancellation/error messages would pollute the new run.
      const ownsSession = !getSession(sessionId) || getSession(sessionId) === session;

      if (ownsSession) {
        FrontendClient.sendError({
          id: sessionId,
          type: "error",
          error: classified.message,
          agentType: "claude",
          category: classified.category,
        });

        const statusResult = updateSessionStatus(
          sessionId,
          "error",
          classified.message,
          classified.category
        );
        if (!statusResult.ok) {
          // Session is now stuck — notify frontend so it can attempt recovery
          FrontendClient.sendError({
            id: sessionId,
            type: "error",
            error: `Session status update failed: ${statusResult.error}`,
            agentType: "claude",
            category: "db_write",
          });
        }
      }
    } finally {
      // Only clean up if this generator still owns the session.
      // A rapid re-query can replace the session before this finally runs;
      // blindly deleting would wipe the new session's state.
      const currentSession = getSession(sessionId);
      if (!currentSession || currentSession === session) {
        deleteQuery(sessionId);
        deleteSession(sessionId);
      }
    }
  }
}
