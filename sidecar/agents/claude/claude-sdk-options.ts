// sidecar/agents/claude/claude-sdk-options.ts
// Builds the full SDK options object for a Claude query, including
// canUseTool callback, hooks, MCP server injection, and all config.

import * as fs from "fs";
import * as path from "path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { FrontendClient } from "../../frontend-client";
import { createCheckpoint } from "./checkpoint";
import { createHiveMCPServer } from "../hive-tools";
import { createNotebookMCPServer } from "../notebook-server";
import { getClaudeExecutablePath } from "./claude-discovery";
import { mapModelForProvider } from "./claude-models";
import { getSession } from "./claude-session";
import type { QueryOptions } from "../agent-handler";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_PROMPT = {
  type: "preset" as const,
  preset: "claude_code",
};

export const DEFAULT_SETTING_SOURCES = ["user", "project", "local"];

/**
 * Appended to the Claude Code system prompt. Provides workspace context
 * and teaches the agent about the persistent notebook REPL.
 */
export const APPEND_SYSTEM_PROMPT = `
# Hive IDE

You are running inside Hive, an IDE that orchestrates multiple AI coding agents in parallel. Each workspace is an isolated git worktree branched from the main repo — your working directory is that worktree. You can only edit files within it. The user sees your progress in real-time: chat, file changes, terminal output, and notebook cells.

# Persistent Notebook REPL

You have a stateful JavaScript notebook (notebook_execute, notebook_inspect, notebook_list_cells, notebook_read, notebook_reset). Variables, imports, and functions persist across calls and survive context window compressions. Use it instead of Bash when experimenting, exploring data, or iterating — fix one cell without re-running everything. Use notebook_list_cells after context compression to recover your state. Cells are auto-saved to .context/notebook.ipynb and visible to the user. Use Bash for CLI tools, shell scripts, and test suites.
`.trim();

// ============================================================================
// canUseTool callback
// ============================================================================

/**
 * Creates the canUseTool callback for a Claude session.
 * Handles ExitPlanMode approval and file path guards.
 */
export function createCanUseTool(sessionId: string, workingDirectory: string | undefined) {
  return async (toolName: string, input: any, _toolOptions: any) => {
    // Handle plan mode exit approval
    if (toolName === "ExitPlanMode") {
      const currentSession = getSession(sessionId);

      const response = await FrontendClient.requestExitPlanMode({
        sessionId,
        toolInput: input,
      });

      if (response.approved) {
        if (response.turnId && currentSession?.cwd) {
          const oldTurnId = currentSession.turnId;
          const newTurnId = response.turnId;

          if (oldTurnId) {
            createCheckpoint(
              sessionId,
              oldTurnId,
              "end",
              currentSession.cwd,
              "claudeHandler:exitPlanMode"
            );
          }
          currentSession.turnId = newTurnId;
          createCheckpoint(
            sessionId,
            newTurnId,
            "start",
            currentSession.cwd,
            "claudeHandler:exitPlanMode"
          );
        }

        return {
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
        };
      } else {
        return {
          behavior: "deny",
          message: "Plan denied by user. Please await a further message for an explanation.",
          interrupt: true,
        };
      }
    }

    // Guard edit tools against writing outside allowed directories
    const editTools = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
    if (editTools.includes(toolName)) {
      if (workingDirectory) {
        const filePath = input.file_path || input.notebook_path || "";
        if (filePath) {
          let normalizedFilePath: string;
          try {
            normalizedFilePath = fs.realpathSync(filePath);
          } catch {
            normalizedFilePath = path.resolve(filePath);
          }
          const additionalDirectories =
            getSession(sessionId)?.currentSettings?.additionalDirectories ?? [];
          const allAllowedDirs = [workingDirectory, ...additionalDirectories].map((dir) => {
            try {
              return fs.realpathSync(dir);
            } catch {
              return path.resolve(dir);
            }
          });

          if (
            !allAllowedDirs.some(
              (dir) => normalizedFilePath === dir || normalizedFilePath.startsWith(dir + path.sep)
            )
          ) {
            console.log(
              `[canUseTool] BLOCKED: ${toolName} on ${filePath} - outside: ${allAllowedDirs.join(", ")}`
            );
            return {
              behavior: "deny",
              message: `Cannot edit files outside allowed directories (${allAllowedDirs.join(", ")}). Attempted: ${filePath}`,
            };
          }
        }
      }
    }

    return { behavior: "allow", updatedInput: input };
  };
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Creates the hooks object for a Claude SDK session.
 * Handles checkpointing at turn boundaries and plan mode notifications.
 */
export function createHooks(sessionId: string) {
  return {
    UserPromptSubmit: [
      {
        hooks: [
          (_input: any) => {
            const currentSession = getSession(sessionId);
            const turnId = currentSession?.turnId;
            if (!turnId) return Promise.resolve({});
            createCheckpoint(sessionId, turnId, "start", _input.cwd, "claudeHandler");
            return Promise.resolve({});
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          (_input: any) => {
            const currentSession = getSession(sessionId);
            const turnId = currentSession?.turnId;
            if (!turnId) return Promise.resolve({});
            createCheckpoint(sessionId, turnId, "end", _input.cwd, "claudeHandler");
            return Promise.resolve({});
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "EnterPlanMode",
        hooks: [
          () => {
            FrontendClient.sendEnterPlanModeNotification({
              type: "enter_plan_mode_notification",
              id: sessionId,
              agentType: "claude",
            });
            return Promise.resolve({});
          },
        ],
      },
    ],
  };
}

// ============================================================================
// SDK Options Builder
// ============================================================================

/**
 * Builds the complete SDK options object for a Claude query.
 */
export function buildSdkOptions(
  sessionId: string,
  env: Record<string, string>,
  options: QueryOptions
): Options {
  const modelToUse = mapModelForProvider(options?.model, env);
  const workingDirectory = options?.cwd;
  const permissionMode = options?.permissionMode;

  const sdkOptions: Record<string, unknown> = {
    maxTurns: options?.maxTurns || 1_000,
    model: modelToUse,
    maxThinkingTokens: options?.maxThinkingTokens,
    cwd: workingDirectory,
    pathToClaudeCodeExecutable: getClaudeExecutablePath(),
    systemPrompt: DEFAULT_PROMPT,
    appendSystemPrompt: APPEND_SYSTEM_PROMPT,
    settingSources: DEFAULT_SETTING_SOURCES,
    canUseTool: createCanUseTool(sessionId, workingDirectory),
    additionalDirectories: options?.additionalDirectories ?? [],
    env,
    disallowedTools: ["AskUserQuestion"],
    permissionMode: permissionMode ?? "default",
  };

  if (options?.chromeEnabled) {
    sdkOptions.extraArgs = { chrome: null };
  }

  if (options?.resumeSessionAt) {
    sdkOptions.resumeSessionAt = options.resumeSessionAt;
  }

  if (options?.resume) {
    sdkOptions.resume = options.resume;
  }

  sdkOptions.hooks = createHooks(sessionId);

  if (!options?.strictDataPrivacy) {
    sdkOptions.mcpServers = {
      hive: createHiveMCPServer(sessionId),
      ...createNotebookMCPServer(workingDirectory),
    };
  }

  return sdkOptions as unknown as Options;
}
