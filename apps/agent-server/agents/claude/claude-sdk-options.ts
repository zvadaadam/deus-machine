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

// ============================================================================
// Thinking level → SDK options
// ============================================================================
//
// Translates the wire-protocol ThinkingLevel into Claude Agent SDK options.
// Centralizing here means adding a new SDK parameter (e.g. `effort: "xhigh"`
// once the SDK typedef catches up to Opus 4.7) is a one-line change.
//
// On Opus 4.6+ the SDK currently treats maxThinkingTokens as on/off
// (0 = disabled, any non-zero = adaptive enabled). The graduated numbers
// still differentiate on older models and preserve intent.

type ThinkingLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";

// NONE uses 0 to explicitly disable thinking on Opus 4.6+ (where the SDK
// treats maxThinkingTokens as on/off: 0 = disabled, any non-zero = adaptive
// enabled). Leaving it undefined would fall through to the SDK default
// behavior (thinking ON), which is the opposite of the user's intent.
const LEVEL_TO_MAX_TOKENS: Record<ThinkingLevel, number> = {
  NONE: 0,
  LOW: 4096,
  MEDIUM: 8192,
  HIGH: 16384,
  XHIGH: 32768,
};

/**
 * Resolves the Claude SDK options that realize a given thinking level.
 * Returns `{ maxThinkingTokens: undefined }` only when no level given — the
 * SDK then uses its default. When NONE is explicitly chosen, returns 0 so the
 * SDK disables thinking rather than falling back to its default.
 */
export function resolveThinkingOptions(thinkingLevel: string | undefined): {
  maxThinkingTokens: number | undefined;
} {
  if (!thinkingLevel) return { maxThinkingTokens: undefined };
  const level = thinkingLevel.toUpperCase() as ThinkingLevel;
  return { maxThinkingTokens: LEVEL_TO_MAX_TOKENS[level] };
}

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
              agentHarness: "claude",
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
  const workingDirectory = options?.cwd;
  const permissionMode = (options?.permissionMode ?? "default") as PermissionMode;
  const thinking = resolveThinkingOptions(options?.thinkingLevel);

  // Built as Partial<Options> and conditionally extended.
  // Cast to Options at return — the SDK validates at runtime.
  const sdkOptions: Partial<Options> = {
    maxTurns: options?.maxTurns || 1_000,
    model: options?.model,
    maxThinkingTokens: thinking.maxThinkingTokens,
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
