// agent-server/agents/claude/claude-handler.ts
// ClaudeAgentHandler — implements AgentHandler for the Claude Agent SDK.
// Orchestrates the generator lifecycle, delegates to focused modules.

import { query as claudeSDK, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import { getErrorMessage } from "@shared/lib/errors";
import { uuidv7 } from "@shared/lib/uuid";
import { createCheckpoint } from "./checkpoint";
import { AsyncQueue } from "../async-queue";
import { createStreamContext } from "./stream-context";
import { classifyError, handleCancellation, handleQueryError } from "../lifecycle";
import {
  deserializeMessage,
  processMessage,
  type ProcessMessageOptions,
} from "./message-processor";
import { EventBroadcaster } from "../../event-broadcaster";
import { claudeCodeAdapter } from "../../messages/claude-adapter";
import type { ClaudeCodeEvent } from "../../messages/claude-events";
import type {
  AgentCapabilities,
  AgentHandler,
  AuthParams,
  ContextUsageParams,
  InitWorkspaceParams,
  QueryOptions,
} from "../registry";
import { buildAgentEnvironment } from "../environment";
import {
  initializeClaude,
  blockIfNotInitialized,
  getClaudeExecutablePath,
} from "./claude-discovery";
import {
  buildSdkOptions,
  DEFAULT_PROMPT,
  DEFAULT_SETTING_SOURCES,
  resolveThinkingOptions,
} from "./claude-sdk-options";
import {
  claudeSessions,
  claudeQueries,
  settingsChanged,
  terminateSession,
  isSessionActive,
  type SessionState,
} from "./claude-session";
import { attachQuery, detachQuery } from "../../app-registrar";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

// Internal-only type for the private workspace init helper
interface WorkspaceInitOptions {
  cwd: string;
  ghToken?: string;
  providerEnvVars?: string;
}

// ============================================================================
// buildPromptIterable — parses queue messages into SDK-compatible user turns
// ============================================================================

/**
 * Wraps an AsyncQueue of raw prompt strings into the async-iterable format
 * expected by the Claude Agent SDK. Handles both plain text and JSON-encoded
 * content blocks (when user attaches images).
 */
function getInvalidWorkspacePathError(cwd: string | undefined): string | null {
  if (!cwd) {
    return "Workspace path is missing for this Claude session.";
  }

  if (!fs.existsSync(cwd)) {
    return `Workspace path does not exist: ${cwd}. This workspace likely points to a deleted or transient folder. Remove and recreate it.`;
  }

  return null;
}

function buildPromptIterable(queue: AsyncQueue<string>, sessionId: string) {
  return (async function* () {
    for await (const message of queue) {
      let content: string | unknown[] = message;
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
}

// ============================================================================
// ClaudeAgentHandler
// ============================================================================

export class ClaudeAgentHandler implements AgentHandler {
  readonly agentHarness = "claude" as const;
  readonly capabilities: AgentCapabilities = {
    auth: true,
    workspaceInit: true,
    contextUsage: true,
    permissionMode: true,
    modelSwitch: "in-session",
    multiTurn: true,
    sessionResume: true,
  };

  initialize(): { success: boolean; error?: string } {
    return initializeClaude();
  }

  async query(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    const tQueryStart = Date.now();
    console.log(`[TIMING][query] START session=${sessionId} promptLength=${prompt.length}`);
    if (blockIfNotInitialized(sessionId)) return;

    const session = claudeSessions.get(sessionId);
    const modelChanged = session?.currentModel !== options.model;
    const requestedMaxThinkingTokens = resolveThinkingOptions(
      options.thinkingLevel
    ).maxThinkingTokens;
    const maxThinkingTokensChanged =
      session?.currentMaxThinkingTokens !== requestedMaxThinkingTokens;
    const settingsChangedFlag = settingsChanged(session?.currentSettings, options);

    if (session) {
      session.turnId = options.turnId;
      session.turnVersion += 1;
      session.cwd = options.cwd;
    }

    const canReuse =
      isSessionActive(session) && options.shouldResetGenerator !== true && !settingsChangedFlag;

    if (canReuse) {
      console.log(
        `[TIMING][query] REUSE session=${sessionId} decisionTime=${Date.now() - tQueryStart}ms`
      );

      // Hot-swap model if it changed
      if (modelChanged && session) {
        const query = claudeQueries.get(sessionId);
        if (query) {
          console.log(
            `Model changed from ${session.currentModel} to ${options.model}, using setModel callback`
          );
          try {
            await query.setModel(options.model);
            const updatedSession = claudeSessions.get(sessionId);
            if (updatedSession) updatedSession.currentModel = options.model;
          } catch (error) {
            console.error(`Failed to update model: ${getErrorMessage(error)}`);
          }
        }
      }

      // Hot-swap maxThinkingTokens if it changed
      const query = claudeQueries.get(sessionId);
      if (maxThinkingTokensChanged && session && query) {
        try {
          await query.setMaxThinkingTokens(requestedMaxThinkingTokens ?? null);
          session.currentMaxThinkingTokens = requestedMaxThinkingTokens;
        } catch (error) {
          console.error(`Failed to update maxThinkingTokens: ${getErrorMessage(error)}`);
        }
      }

      // Update permission mode if provided
      if (query && options.permissionMode) {
        try {
          await query.setPermissionMode(options.permissionMode as PermissionMode);
        } catch (error) {
          console.error(`Failed to update permission mode: ${getErrorMessage(error)}`);
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
      console.log(
        `[TIMING][query] NEW_GENERATOR session=${sessionId} reason="${reason}" decisionTime=${Date.now() - tQueryStart}ms`
      );

      if (isSessionActive(session)) {
        terminateSession(sessionId);
      }

      const newSession: SessionState = {
        currentSettings: {
          providerEnvVars: options.providerEnvVars,
          additionalDirectories: options.additionalDirectories,
          chromeEnabled: options.chromeEnabled,
          strictDataPrivacy: options.strictDataPrivacy,
        },
        currentModel: options.model,
        currentMaxThinkingTokens: requestedMaxThinkingTokens,
        turnId: options.turnId,
        turnVersion: 1,
        cwd: options.cwd,
      };
      claudeSessions.set(sessionId, newSession);

      void this.processWithGenerator(sessionId, prompt, options);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    console.log("Handling Claude cancel request for session:", sessionId);
    if (blockIfNotInitialized(sessionId)) return;

    const existingQuery = claudeQueries.get(sessionId);
    const session = claudeSessions.get(sessionId);

    if (isSessionActive(session) && existingQuery) {
      console.log(`Force-closing query for session ${sessionId}`);

      // 1. Flag cancellation so the post-loop path persists the cancelled message
      session.cancelledByUser = true;

      // 2. Create checkpoint before process dies
      if (session.turnId && session.cwd) {
        createCheckpoint(sessionId, session.turnId, "end", session.cwd, "claudeHandler");
      }

      // 3. Force kill: close() terminates CLI subprocess + all children + MCP transports
      existingQuery.close();

      // 4. Signal prompt generator to stop — finally block owns cleanup
      terminateSession(sessionId);
    } else {
      console.log(`No active session found for ${sessionId} to cancel`);
    }
  }

  reset(sessionId: string): void {
    console.log(`Handling reset generator request for session: ${sessionId}`);
    const session = claudeSessions.get(sessionId);
    if (session) {
      console.log(`Terminating generator for session ${sessionId} on reset request`);
      terminateSession(sessionId);
    }
  }

  // ==========================================================================
  // Optional interface methods (provider-specific, guarded by capabilities)
  // ==========================================================================

  async auth(params: AuthParams) {
    const { accountInfo, error } = await this.getClaudeAccountInfo(params.cwd);
    return {
      type: "claude_auth_output",
      agentHarness: "claude",
      accountInfo,
      error,
    };
  }

  async initWorkspace(params: InitWorkspaceParams) {
    const { slashCommands, mcpServers, error } = await this.getClaudeWorkspaceInitData({
      cwd: params.cwd,
      ghToken: params.ghToken,
      providerEnvVars: params.providerEnvVars,
    });
    return {
      type: "workspace_init_output",
      agentHarness: "claude",
      slashCommands,
      mcpServers,
      error,
    };
  }

  async updatePermissionMode(sessionId: string, permissionMode: string): Promise<void> {
    console.log(`Handling permission mode update for session ${sessionId}: ${permissionMode}`);
    const session = claudeSessions.get(sessionId);
    const existingQuery = claudeQueries.get(sessionId);

    if (!session) {
      console.log(`No active session found for ${sessionId}, ignoring permission mode update`);
      return;
    }

    if (existingQuery) {
      try {
        await existingQuery.setPermissionMode(permissionMode as PermissionMode);
        console.log(`Permission mode updated to ${permissionMode} for session ${sessionId}`);
      } catch (error) {
        console.error(`Failed to update permission mode: ${getErrorMessage(error)}`);
      }
    }
  }

  async getContextUsage(request: ContextUsageParams) {
    const { id: sessionId, options } = request;
    const agentSessionId = options.agentSessionId;

    console.log(
      `[getContextUsage] Getting context usage for session: ${sessionId}, agentSessionId: ${agentSessionId}`
    );

    if (!agentSessionId) throw new Error("No agentSessionId provided");
    if (blockIfNotInitialized(sessionId)) throw new Error("Initialization failure");

    const sdkOptions = {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: getClaudeExecutablePath(),
      systemPrompt: DEFAULT_PROMPT,
      settingSources: DEFAULT_SETTING_SOURCES,
      resume: agentSessionId,
    };

    const contextUsageQuery = claudeSDK({ prompt: "/context", options: sdkOptions });

    try {
      for await (const message of contextUsageQuery) {
        if (message.type !== "user") continue;
        return {
          type: "context_usage",
          id: sessionId,
          agentHarness: "claude",
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
      return { error: getErrorMessage(error) };
    } finally {
      void queryResult.interrupt().catch((error: Error) => {
        console.error(`[getClaudeAccountInfo] Error during interrupt:`, error);
      });
    }
  }

  private async getClaudeWorkspaceInitData(options: WorkspaceInitOptions) {
    const envForClaude = buildAgentEnvironment({
      providerEnvVars: options.providerEnvVars,
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
      return { error: getErrorMessage(error) };
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
    const session = claudeSessions.get(sessionId);
    if (!session) {
      console.error(`[${generatorId}] Session ${sessionId} not found`);
      return;
    }
    console.log(`[TIMING][${generatorId}] processWithGenerator START`);

    // --- Message queue for multi-turn conversations ---
    const promptQueue = new AsyncQueue<string>([initialPrompt]);

    session.sendMessage = (message: string) => {
      console.log(`[${generatorId}] Pushing message to queue`);
      promptQueue.push(message);
    };

    session.sendTerminate = () => {
      console.log(`[${generatorId}] Sending terminate signal`);
      promptQueue.close();
    };

    // Mutable context accumulated during the streaming loop.
    const ctx = createStreamContext();

    // Hoisted so the finally block can detach from the app-registrar even
    // when an early throw (e.g. invalid cwd) happens before SDK construction.
    let queryResult: ReturnType<typeof claudeSDK> | undefined;

    try {
      const invalidWorkspacePathError = getInvalidWorkspacePathError(options.cwd);
      if (invalidWorkspacePathError) {
        throw new Error(invalidWorkspacePathError);
      }

      // Build environment using shared env-builder
      const tEnvStart = Date.now();
      const envForClaude = buildAgentEnvironment({
        providerEnvVars: options?.providerEnvVars,
        deusEnv: options?.deusEnv,
        ghToken: options?.ghToken,
        extraEnv: { CLAUDE_CODE_ENABLE_TASKS: "true" },
      });
      console.log(
        `[TIMING][${generatorId}] buildAgentEnvironment took ${Date.now() - tEnvStart}ms`
      );

      // Resume is now passed in turn/start params from the backend (which owns the DB
      // and knows the agent_session_id). The agent-server is stateless — no DB lookups.
      if (options.resume) {
        console.log(
          `[RESUME-DEBUG][${generatorId}] Attempting resume with agent_session_id=${options.resume} for session=${sessionId}`
        );
      }

      // Build SDK options using the dedicated builder
      const tSdkOptsStart = Date.now();
      const sdkOptions = buildSdkOptions(sessionId, envForClaude, options);
      console.log(`[TIMING][${generatorId}] buildSdkOptions took ${Date.now() - tSdkOptsStart}ms`);

      const promptInput = buildPromptIterable(promptQueue, sessionId);

      // Start the SDK query
      console.log(
        `[TIMING][${generatorId}] SDK spawn starting (elapsed since processStart: ${Date.now() - tProcessStart}ms)`
      );
      console.log(
        `[RESUME-DEBUG][${generatorId}] SDK options: resume=${sdkOptions.resume ?? "none"} cwd=${sdkOptions.cwd} model=${sdkOptions.model} permissionMode=${sdkOptions.permissionMode}`
      );
      const tSdkSpawn = Date.now();
      queryResult = claudeSDK({ prompt: promptInput, options: sdkOptions });
      console.log(
        `[TIMING][${generatorId}] claudeSDK() constructor returned in ${Date.now() - tSdkSpawn}ms`
      );

      claudeQueries.set(sessionId, queryResult);
      // Pin the session's initial SDK servers (the `deus` tools) so any
      // subsequent AAP-MCP broadcast preserves them. Without this, the SDK's
      // setMcpServers would disconnect the deus transport and hang any
      // tool call that's mid-flight on it (e.g. `launch_app` itself, which
      // triggers the very broadcast that kills its own transport).
      const sdkServers = (sdkOptions.mcpServers ?? {}) as Record<
        string,
        McpSdkServerConfigWithInstance
      >;
      attachQuery(queryResult, sdkServers);
      session.generator = queryResult[Symbol.asyncIterator]();

      // Per-message options (constant for the lifetime of this generator).
      // Model is required — the backend forwards the client's choice and
      // a missing value means a bug upstream. Fail loud rather than silently
      // picking a default that could mislead billing and audit logs.
      if (!options.model) {
        throw new Error(`[claude-handler] options.model is required (session=${sessionId})`);
      }
      const msgOpts: ProcessMessageOptions = {
        sessionId,
        generatorId,
        model: options.model,
        isResume: !!options.resume,
      };

      // Unified Part transformer: runs alongside the legacy event path.
      // Each SDK event is fed through the transformer, producing PartEvents
      // that are emitted individually as canonical lifecycle events.
      //
      // The transformer and messageId are recreated per turn so that
      // multi-turn sessions (generator reuse) get fresh IDs.
      let currentTurnVersion = session.turnVersion;
      let currentTurnId = session.turnId;
      let messageId = uuidv7();
      let transformer = claudeCodeAdapter.createTransformer({
        sessionId,
        messageId,
        turnId: currentTurnId,
      });

      // Emit turn.started for the initial turn
      EventBroadcaster.emitPartEvent(sessionId, "claude", messageId, {
        type: "turn.started",
        turnId: currentTurnId,
      });

      // Track the current sub-message ID (updated by message.created events from the adapter)
      let currentSubMessageId = messageId;

      /** Emit a PartEvent, using the sub-message ID from message.created for proper FK linking. */
      function emitEvt(evt: import("../../messages/adapter").PartEvent) {
        // message.created / message.done carry their own messageId (the sub-message ID)
        if (evt.type === "message.created" || evt.type === "message.done") {
          currentSubMessageId = evt.messageId;
        }
        EventBroadcaster.emitPartEvent(sessionId, "claude", currentSubMessageId, evt);
      }

      // Stream messages back to the frontend and persist to DB.
      const tStreamStart = Date.now();
      for await (const message of queryResult) {
        ctx.messageCount++;
        if (ctx.firstMessageTime === null) {
          ctx.firstMessageTime = Date.now();
          console.log(
            `[TIMING][${generatorId}] FIRST_MESSAGE received after ${ctx.firstMessageTime - tSdkSpawn}ms (type=${(message as any)?.type})`
          );
        }

        // Detect turn boundary: session.turnVersion is incremented by query()
        // on each new turn, so when it changes we need a fresh transformer.
        if (session.turnVersion !== currentTurnVersion) {
          const prevFinished = transformer.finish();
          for (const evt of prevFinished.events) emitEvt(evt);

          currentTurnVersion = session.turnVersion;
          currentTurnId = session.turnId;
          messageId = uuidv7();
          currentSubMessageId = messageId;
          transformer = claudeCodeAdapter.createTransformer({
            sessionId,
            messageId,
            turnId: currentTurnId,
          });

          emitEvt({ type: "turn.started", turnId: currentTurnId });
        }

        // Deserialize, persist, and forward to frontend.
        if (message) {
          const cleanMessage = deserializeMessage(message, generatorId);
          if (!cleanMessage) continue;

          processMessage(cleanMessage, ctx, session, msgOpts);

          // Transform into PartEvents and emit each individually
          const events = transformer.process(cleanMessage as unknown as ClaudeCodeEvent);
          for (const evt of events) emitEvt(evt);

          // Log per-message timing for first 5 messages, then every 10th
          if (ctx.messageCount <= 5 || ctx.messageCount % 10 === 0) {
            console.log(
              `[TIMING][${generatorId}] msg#${ctx.messageCount} type=${cleanMessage.type}${cleanMessage.type === "result" ? "/" + cleanMessage.subtype : ""} elapsed=${Date.now() - tStreamStart}ms`
            );
          }
        }
      }

      // Finalize the last turn's transformer
      const finished = transformer.finish();
      for (const evt of finished.events) emitEvt(evt);

      console.log(
        `[TIMING][${generatorId}] STREAM_COMPLETE messages=${ctx.messageCount} totalStreamTime=${Date.now() - tStreamStart}ms totalProcessTime=${Date.now() - tProcessStart}ms`
      );

      // Post-loop: stream ended cleanly (prompt queue closed or SDK finished).
      // Turn-level idle is already set by processMessage on result/success.
      // This handles conversation-end: cancel persistence only.
      if (handleCancellation(sessionId, "claude", !!session.cancelledByUser)) {
        console.log(`[${generatorId}] Session cancelled by user: ${sessionId}`);
        return;
      }
      console.log(`[${generatorId}] Stream completed: ${sessionId}`);
    } catch (error) {
      // Cancel takes priority — abort signal can surface as a thrown error.
      if (handleCancellation(sessionId, "claude", !!session.cancelledByUser)) {
        console.log(`[${generatorId}] Session cancelled by user (catch): ${sessionId}`);
        return;
      }

      // Post-success process exit: the CLI shuts down between turns and the
      // SDK reports the signal-based exit as an error. Expected cleanup, not failure.
      if (ctx.querySucceeded) {
        console.log(`[${generatorId}] Process exited after successful query (expected cleanup)`);
        return;
      }

      // Genuine error — check if this generator still owns the session.
      // A rapid re-query can replace the session before the catch runs.
      const errorName = error instanceof Error ? error.name : "non-Error";
      const errorStack =
        error instanceof Error ? error.stack?.split("\n").slice(0, 5).join("\n") : "no stack";
      const extraProps =
        error instanceof Error
          ? Object.getOwnPropertyNames(error)
              .filter((k) => !["message", "stack", "name"].includes(k))
              .map((k) => `${k}=${JSON.stringify((error as any)[k])}`)
              .join(" ")
          : "";

      const classified = classifyError(error);

      console.error(
        `[${generatorId}] Error in Claude query [${classified.category}]:`,
        classified.message
      );
      console.error(
        `[${generatorId}] Error details:`,
        `name=${errorName}`,
        `wasResume=${!!options.resume}`,
        `resumeId=${options.resume ?? "none"}`,
        `querySucceeded=${ctx.querySucceeded}`,
        `messageCount=${ctx.messageCount}`,
        extraProps ? `extraProps={${extraProps}}` : "extraProps={}"
      );
      console.error(`[${generatorId}] Stack (top 5):\n${errorStack}`);

      if (claudeSessions.owns(sessionId, session)) {
        handleQueryError(sessionId, "claude", error, (c) => {
          if (c.category !== "process_exit") return c.message;
          const parts: string[] = [c.message];
          if (options.resume) parts.push("(resumed session)");
          if (ctx.messageCount > 0) {
            parts.push(`after ${ctx.messageCount} message${ctx.messageCount !== 1 ? "s" : ""}`);
          } else {
            parts.push("before receiving any messages");
          }
          if (ctx.lastResultError) parts.push(`— ${ctx.lastResultError}`);
          if (extraProps) parts.push(`[${extraProps}]`);
          return parts.join(" ");
        });
      }
    } finally {
      // Only clean up if this generator still owns the session.
      // A rapid re-query can replace the session before this finally runs;
      // blindly deleting would wipe the new session's state.
      if (claudeSessions.owns(sessionId, session)) {
        if (queryResult) detachQuery(queryResult);
        claudeQueries.delete(sessionId);
        claudeSessions.delete(sessionId);
      }
    }
  }
}
