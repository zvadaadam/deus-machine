// agent-server/agents/environment/cli-discovery.ts
// Generic CLI executable discovery for all agent handlers.
// Each agent provides a DiscoveryConfig describing what to find;
// this module handles the discovery algorithm (candidate gathering,
// shell PATH discovery, candidate verification, init guard).

import * as path from "path";
import * as fs from "fs";
import { execSync, execFileSync } from "child_process";
import { EventBroadcaster } from "../../event-broadcaster";
import type { AgentHarness } from "../../protocol";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for discovering a CLI executable.
 * Each agent provides one of these — the only thing that varies between agents.
 */
export interface DiscoveryConfig {
  /** Agent type for error messages (e.g. "claude", "codex") */
  agentHarness: AgentHarness;
  /** Human-readable name for log messages (e.g. "Claude", "Codex") */
  displayName: string;
  /** Env var override (e.g. "CLAUDE_CLI_PATH", "CODEX_CLI_PATH") */
  envVar: string;
  /** Static candidate paths (known install locations) */
  staticCandidates: string[];
  /** Shell command name for dynamic discovery (e.g. "claude", "codex") */
  shellCommand: string;
  /** Version flag to verify the candidate (e.g. "-v", "--version") */
  versionFlag: string;
  /**
   * Optional: additional candidates discovered programmatically
   * (e.g. Codex's require.resolve for bundled npm binary).
   * Returns additional paths to try, or empty array.
   */
  extraCandidates?: () => string[];
}

/**
 * Mutable state for a single agent's discovery result.
 * Owned by each agent's discovery wrapper module.
 */
export interface DiscoveryState {
  executablePath: string;
  result: { success: boolean; path?: string; error?: string } | null;
}

// ============================================================================
// Discovery Algorithm
// ============================================================================

/**
 * Discovers and verifies a CLI executable using the given config.
 * Mutates `state` with the result.
 *
 * Algorithm:
 * 1. Gather candidates: env var → static paths → extra candidates → shell PATH
 * 2. For each candidate: verify it exists, run `<candidate> <versionFlag>`
 * 3. First success wins; all failures produce a descriptive error.
 */
export function discoverExecutable(
  config: DiscoveryConfig,
  state: DiscoveryState
): { success: boolean; error?: string } {
  console.log(`Setting up ${config.displayName} executable path...`);

  // Build candidate list
  const candidates: string[] = [];

  // Env var override (highest priority)
  const envOverride = process.env[config.envVar];
  if (envOverride) candidates.push(envOverride);

  // Static candidate paths
  candidates.push(...config.staticCandidates);

  // Extra programmatic candidates (e.g. require.resolve for bundled binary)
  if (config.extraCandidates) {
    try {
      const extra = config.extraCandidates();
      for (const p of extra) {
        if (p && !candidates.includes(p)) candidates.push(p);
      }
    } catch {
      // Extra candidate discovery failed — continue
    }
  }

  // Dynamic discovery: find via user's login shell PATH.
  // Node's child_process inherits a minimal env, so run through login shell
  // to pick up ~/.local/bin, nvm paths, etc.
  // Strip node_modules/.bin from PATH to avoid finding SDK's internal
  // CLI wrapper (which crashes on version check in bundled/test contexts).
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const cleanEnv = { ...process.env };
    if (cleanEnv.PATH) {
      cleanEnv.PATH = cleanEnv.PATH.split(":")
        .filter((p) => !p.includes("node_modules"))
        .join(":");
    }
    const resolved = execSync(`"${shell}" -l -c "command -v ${config.shellCommand}"`, {
      encoding: "utf-8",
      timeout: 5000,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (resolved && !candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  } catch {
    // Shell discovery failed — continue with static candidates
  }

  // Verify each candidate
  const triedCandidates: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;

    // Avoid shell noise when absolute/relative paths are missing
    const looksLikePath = candidate.includes(path.sep) || candidate.startsWith(".");
    if (looksLikePath && !fs.existsSync(candidate)) {
      triedCandidates.push(candidate);
      continue;
    }

    try {
      const version = verifyCandidate(candidate, config.versionFlag);
      console.log(
        `${config.displayName} executable initialized with version: ${version} at ${candidate}`
      );
      state.executablePath = candidate;
      state.result = { success: true, path: candidate };
      return { success: true };
    } catch {
      triedCandidates.push(candidate);
    }
  }

  const errorMessage = `Failed to find ${config.displayName} executable. Tried: ${triedCandidates.join(", ")}`;
  console.error(`${config.displayName} executable initialization failed: ${errorMessage}`);
  state.result = { success: false, error: errorMessage };
  return { success: false, error: errorMessage };
}

function verifyCandidate(candidate: string, versionFlag: string): string {
  const opts = {
    encoding: "utf-8" as const,
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };

  // JS entrypoint installed via a global package manager
  if (candidate.endsWith(".js")) {
    return execFileSync("node", [candidate, versionFlag], opts).trim();
  }

  // Native binary/symlink
  return execFileSync(candidate, [versionFlag], opts).trim();
}

// ============================================================================
// Init Guard
// ============================================================================

/**
 * Checks if initialization succeeded, and sends an error to the frontend if not.
 * Returns true if blocked (initialization failed), false if OK to proceed.
 */
export function blockIfNotInitialized(
  state: DiscoveryState,
  agentHarness: AgentHarness,
  sessionId: string
): boolean {
  if (!state.result?.success) {
    const errorMsg = `Cannot process request: ${state.result?.error || "Initialization failed"}`;
    // Emit canonical error event so the backend updates session status.
    // The backend set status='working' before forwarding turn/start to the agent-server.
    try {
      EventBroadcaster.emitSessionError(sessionId, agentHarness, errorMsg, "internal");
    } catch (error) {
      console.warn(`[CLI-DISCOVERY] Failed to emit session error:`, error);
    }
    console.log(`Blocked ${agentHarness} request due to initialization failure`);
    return true;
  }
  return false;
}
