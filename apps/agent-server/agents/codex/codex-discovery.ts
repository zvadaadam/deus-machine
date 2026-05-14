// agent-server/agents/codex/codex-discovery.ts
// Codex CLI executable discovery — thin wrapper over shared cli-discovery.
// Preserves the same 3 exported functions that codex-handler.ts imports.

import {
  discoverExecutable,
  blockIfNotInitialized as sharedBlock,
  type DiscoveryState,
} from "../environment/cli-discovery";
import { getPackagedCodexCandidates } from "../environment/packaged-cli-paths";

// ============================================================================
// State
// ============================================================================

const state: DiscoveryState = { executablePath: "", result: null };

// ============================================================================
// Public API (same signatures as before)
// ============================================================================

/** Returns the discovered Codex CLI executable path. */
export function getCodexExecutablePath(): string {
  return state.executablePath;
}

/**
 * Discovers and verifies the Codex executable.
 * Called once at agent-server startup.
 */
export function initializeCodex(): { success: boolean; error?: string } {
  return discoverExecutable(
    {
      agentHarness: "codex-sdk",
      displayName: "Codex",
      envVar: "CODEX_CLI_PATH",
      staticCandidates: getPackagedCodexCandidates(),
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
  return sharedBlock(state, "codex-sdk", sessionId);
}
