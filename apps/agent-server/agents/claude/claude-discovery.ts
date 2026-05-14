// agent-server/agents/claude/claude-discovery.ts
// Claude CLI executable discovery — thin wrapper over shared cli-discovery.
// Preserves the same 3 exported functions that claude-handler.ts,
// claude-sdk-options.ts, and claude-handler.test.ts import.

import {
  discoverExecutable,
  blockIfNotInitialized as sharedBlock,
  type DiscoveryState,
} from "../environment/cli-discovery";

// ============================================================================
// State
// ============================================================================

const state: DiscoveryState = { executablePath: "", result: null };

// ============================================================================
// Public API (same signatures as before)
// ============================================================================

/** Returns the discovered Claude CLI executable path. */
export function getClaudeExecutablePath(): string {
  return state.executablePath;
}

/**
 * Discovers and verifies the Claude executable.
 * Called once at agent-server startup.
 */
export function initializeClaude(): { success: boolean; error?: string } {
  return discoverExecutable(
    {
      agentHarness: "claude",
      displayName: "Claude",
      envVars: ["CLAUDE_CLI_PATH"],
      bundledTool: "claude",
      versionFlag: "--version",
    },
    state
  );
}

/**
 * Checks if initialization succeeded, and sends an error to the frontend if not.
 * Returns true if blocked (initialization failed), false if OK to proceed.
 */
export function blockIfNotInitialized(sessionId: string): boolean {
  return sharedBlock(state, "claude", sessionId);
}
