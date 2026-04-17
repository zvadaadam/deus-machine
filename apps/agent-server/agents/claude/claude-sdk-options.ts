// agent-server/agents/claude/claude-sdk-options.ts
// Builds the full SDK options object for a Claude query, including
// canUseTool callback, hooks, MCP server injection, and all config.

import * as fs from "fs";
import * as path from "path";
import type { Options, PermissionMode, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { EventBroadcaster } from "../../event-broadcaster";
import { createCheckpoint } from "./checkpoint";
import { createDeusMCPServer } from "../deus-tools";
import { getClaudeExecutablePath } from "./claude-discovery";
import { mapModelForProvider, parseModelSpec } from "./claude-models";
import { claudeSessions } from "./claude-session";
import type { QueryOptions } from "../registry";
import { buildWorkspaceContext } from "../environment";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_PROMPT = {
  type: "preset" as const,
  preset: "claude_code" as const,
};

export const DEFAULT_SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

/**
 * Builds the append system prompt with dynamic workspace context.
 * Tells the agent what project it's in and where the worktree lives
 * so it doesn't confuse the workspace name with the project name.
 */
export function buildAppendSystemPrompt(cwd?: string): string {
  const workspaceContext =
    buildWorkspaceContext(cwd) ||
    "You are working inside Deus, a desktop app that orchestrates multiple AI coding agents in parallel.";

  return `
${workspaceContext}

# Screen Recording

You have screen recording tools available directly — just call them, do NOT search for them with ToolSearch. The tools are: recording_start, recording_chapter, recording_status, recording_stop.

**Events are captured automatically.** When a recording is active, every browser tool you use (BrowserClick, BrowserType, BrowserNavigate, BrowserScroll, etc.) automatically feeds the camera engine. You do NOT need to call recording_event — just use browser tools normally.

**When to record:** After completing a significant feature, bug fix, or PR — record a demo showing what changed and how it works. This is especially valuable for UI changes, new flows, or anything visual.

**How to use:**
1. Call recording_start with captureMethod "auto" — on macOS it uses avfoundation for smooth 30fps video (requires Screen Recording permission in System Settings). If permission is not granted, it falls back to events-only mode.
2. Use the browser tools to navigate and interact with the app as a user would — events are recorded automatically
3. Call recording_chapter to add semantic sections ("Login flow", "Dashboard view", etc.)
4. Call recording_stop to produce the final MP4

The camera engine automatically creates cinematic zoom/pan effects: 2x zoom on typing, 1.8x on clicks, 1.3x on scrolling, 1x on navigation. Output is saved as MP4. If outputPath is empty after stop, screen capture failed — check ffmpeg availability.
`.trim();
}

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
      const currentSession = claudeSessions.get(sessionId);

      let response: { approved: boolean; turnId?: string };
      try {
        response = await EventBroadcaster.requestExitPlanMode({
          sessionId,
          toolInput: input,
        });
      } catch (err) {
        console.error("[canUseTool] ExitPlanMode request failed:", err);
        return {
          behavior: "deny",
          message:
            "Plan approval request failed (frontend may be unavailable or timed out). " +
            "Please wait for the user to reconnect and try again.",
          interrupt: true,
        };
      }

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
            claudeSessions.get(sessionId)?.currentSettings?.additionalDirectories ?? [];
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
            const currentSession = claudeSessions.get(sessionId);
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
            const currentSession = claudeSessions.get(sessionId);
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
            EventBroadcaster.sendEnterPlanModeNotification({
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
  const { extended: use1MContext } = parseModelSpec(options?.model ?? "");
  const workingDirectory = options?.cwd;
  const permissionMode = (options?.permissionMode ?? "default") as PermissionMode;

  // Built as Partial<Options> and conditionally extended.
  // Cast to Options at return — the SDK validates at runtime.
  const sdkOptions: Partial<Options> = {
    maxTurns: options?.maxTurns || 1_000,
    model: modelToUse,
    ...(use1MContext ? { betas: ["context-1m-2025-08-07" as const] } : {}),
    maxThinkingTokens: options?.maxThinkingTokens,
    cwd: workingDirectory,
    pathToClaudeCodeExecutable: getClaudeExecutablePath(),
    systemPrompt: {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: buildAppendSystemPrompt(workingDirectory),
    },
    settingSources: DEFAULT_SETTING_SOURCES,
    canUseTool: createCanUseTool(sessionId, workingDirectory),
    additionalDirectories: options?.additionalDirectories ?? [],
    env,
    disallowedTools: ["AskUserQuestion"],
    permissionMode,
    hooks: createHooks(sessionId),
    includePartialMessages: true,
  };

  if (options?.chromeEnabled) {
    (sdkOptions as any).extraArgs = { chrome: null };
  }

  if (options?.resumeSessionAt) {
    sdkOptions.resumeSessionAt = options.resumeSessionAt;
  }

  if (options?.resume) {
    sdkOptions.resume = options.resume;
  }

  if (!options?.strictDataPrivacy) {
    sdkOptions.mcpServers = {
      deus: createDeusMCPServer(sessionId),
    };
  }

  return sdkOptions as Options;
}
