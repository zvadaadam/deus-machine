// sidecar/agents/claude/claude-handler.ts
// ClaudeAgentHandler — implements AgentHandler for the Claude Agent SDK.
// Orchestrates the generator lifecycle, delegates to focused modules.

import { query as claudeSDK } from "@anthropic-ai/claude-agent-sdk";
import { FrontendClient } from "../../frontend-client";
import { createCheckpoint } from "./checkpoint";
import { saveAssistantMessage, updateSessionStatus } from "../../db/session-writer";
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
// ClaudeAgentHandler
// ============================================================================

export class ClaudeAgentHandler implements AgentHandler {
  readonly agentType = "claude" as const;

  initialize(): { success: boolean; error?: string } {
    return initializeClaude();
  }

  async handleQuery(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    console.log("Handling Claude query request for session:", sessionId);
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

    const canUseExistingGenerator =
      session &&
      session.generator &&
      session.sendMessage &&
      options.shouldResetGenerator !== true &&
      !settingsChangedFlag;

    if (canUseExistingGenerator) {
      console.log(`Reusing existing generator for session ${sessionId}`);

      // Hot-swap model if it changed
      if (modelChanged && session) {
        const query = getQuery(sessionId);
        if (query) {
          const envVars = options.claudeEnvVars ? parseEnvString(options.claudeEnvVars) : {};
          const mappedModel = mapModelForProvider(options.model, envVars);
          console.log(
            `Model changed from ${session.currentModel} to ${options.model}, using setModel callback`
          );
          void query
            .setModel(mappedModel)
            .then(() => {
              const updatedSession = getSession(sessionId);
              if (updatedSession) updatedSession.currentModel = options.model;
            })
            .catch((error: Error) => {
              console.error(`Failed to update model: ${error.message}`);
            });
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
      const sendFn = session?.sendMessage;
      if (!sendFn) return; // Narrowing guard — should never happen after canUseExistingGenerator check
      sendFn(prompt);
    } else {
      const reason = !session
        ? "new session"
        : !session.generator
          ? "no existing generator"
          : options.shouldResetGenerator
            ? "should reset generator"
            : "settings changed";
      console.log(`Creating new generator for session ${sessionId} for reason: "${reason}"`);

      if (session?.generator) {
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

    if (session && query && session.generator) {
      console.log(`Interrupting query for session ${sessionId}`);
      await query
        .interrupt()
        .then(() => {
          if (session.turnId && session.cwd) {
            createCheckpoint(sessionId, session.turnId, "end", session.cwd, "claudeHandler");
          }
          FrontendClient.sendError({
            id: sessionId,
            type: "error",
            error: "aborted by user",
            agentType: "claude",
          });
          console.log(`Terminating session ${sessionId} on cancel`);
          terminateSession(sessionId);
        })
        .catch((error: Error) => {
          console.error(
            `[handleClaudeCancel] Error during cancel interrupt for session ${sessionId}:`,
            error
          );
        });
      deleteSession(sessionId);
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

  async claudeAuth(params: { id: string; cwd: string }) {
    const { accountInfo, error } = await this.getClaudeAccountInfo(params.cwd);
    return {
      id: params.id,
      type: "claude_auth_output",
      agentType: "claude",
      accountInfo,
      error,
    };
  }

  async workspaceInit(params: {
    id: string;
    cwd: string;
    ghToken?: string;
    claudeEnvVars?: string;
  }) {
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

  async getContextUsage(request: {
    id: string;
    options: { cwd: string; claudeSessionId: string };
  }) {
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
      void contextUsageQuery.interrupt().catch((error: Error) => {
        console.error(`[getContextUsage] Error during interrupt:`, error);
      });
    }

    throw new Error("No user message found in context usage response");
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  private async getClaudeAccountInfo(cwd: string) {
    try {
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
      const accountInfo = await queryResult.accountInfo();
      void queryResult.interrupt().catch((error: Error) => {
        console.error(`[getClaudeAccountInfo] Error during interrupt:`, error);
      });
      return { accountInfo };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async getClaudeWorkspaceInitData(options: {
    cwd: string;
    ghToken?: string;
    claudeEnvVars?: string;
  }) {
    try {
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

      const [slashCommands, mcpServers] = await Promise.all([
        queryResult.supportedCommands(),
        queryResult.mcpServerStatus(),
      ]);

      void queryResult.interrupt().catch((error: Error) => {
        console.error(`[getClaudeWorkspaceInitData] Error during interrupt:`, error);
      });

      return { slashCommands, mcpServers };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
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
    const generatorId = `${sessionId}/${Date.now()}`;
    const session = getSession(sessionId);
    if (!session) {
      console.error(`[${generatorId}] Session ${sessionId} not found`);
      return;
    }

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
        resolver(messageQueue.shift());
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

    try {
      // Build environment using shared env-builder
      const envForClaude = buildAgentEnvironment({
        claudeEnvVars: options?.claudeEnvVars,
        conductorEnv: options?.conductorEnv,
        ghToken: options?.ghToken,
        extraEnv: { CLAUDE_CODE_ENABLE_TASKS: "true" },
      });

      // Build SDK options using the dedicated builder
      const sdkOptions = buildSdkOptions(sessionId, envForClaude, options);

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

          yield {
            type: "user" as const,
            message: { role: "user" as const, content: message },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        }
      })();

      // Start the SDK query
      const queryResult = claudeSDK({ prompt: promptInput, options: sdkOptions });

      setQuery(sessionId, queryResult);
      session.generator = queryResult[Symbol.asyncIterator]();

      // Stream messages back to the frontend and persist to DB
      for await (const message of queryResult) {
        if (message) {
          const messageStr = safeStringify(message);
          const cleanMessage = JSON.parse(messageStr);

          // Send to frontend via JSON-RPC notification
          FrontendClient.sendMessage({
            id: sessionId,
            type: "message",
            agentType: "claude",
            data: cleanMessage,
          });

          // Persist assistant messages to database
          if (cleanMessage.type === "assistant" && cleanMessage.message) {
            const model = options?.model || "sonnet";
            saveAssistantMessage(sessionId, cleanMessage.message, model);
          }

          // Update session status when query completes successfully
          if (cleanMessage.type === "result" && cleanMessage.subtype === "success") {
            updateSessionStatus(sessionId, "idle");
          }
        }
      }

      console.log(`[${generatorId}] Session completed: ${sessionId}`);
    } catch (error) {
      console.error(`[${generatorId}] Error in Claude query:`, error);

      if (!(error instanceof Error && error.name === "AbortError")) {
        FrontendClient.sendError({
          id: sessionId,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
          agentType: "claude",
        });
      }
    } finally {
      deleteQuery(sessionId);
      deleteSession(sessionId);
    }
  }
}
