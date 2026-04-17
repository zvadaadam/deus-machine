// agent-server/agents/codex/codex-discovery.ts
// Codex CLI executable discovery — thin wrapper over shared cli-discovery.
// Preserves the same 3 exported functions that codex-handler.ts imports.

import * as path from "path";
import * as fs from "fs";
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
      agentHarness: "codex",
      displayName: "Codex",
      envVar: "CODEX_CLI_PATH",
      staticCandidates: ["/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"],
      shellCommand: "codex",
      versionFlag: "--version",
      extraCandidates: () => {
        // Try to find the binary bundled with @openai/codex npm package
        try {
          const codexPkgPath = require.resolve("@openai/codex/package.json");
          const codexDir = path.dirname(codexPkgPath);
          const binPath = path.join(codexDir, "bin", "codex.js");
          if (fs.existsSync(binPath)) return [binPath];
        } catch {
          // @openai/codex not installed as a direct dependency
        }
        return [];
      },
    },
    state
  );
}

/**
 * Checks if initialization succeeded, and sends an error to the frontend if not.
 * Returns true if blocked (initialization failed), false if OK to proceed.
 */
export function blockIfNotInitialized(sessionId: string): boolean {
  return sharedBlock(state, "codex", sessionId);
}
