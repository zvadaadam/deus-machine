// agent-server/agents/environment/cli-discovery.ts
// Generic CLI executable resolution for agent handlers.
// Agent CLIs are resolved deterministically: explicit override first, then
// bundled/runtime candidates. We intentionally do not scan the user's shell for
// global installs; packaged builds should use the binary we ship.

import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
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
  /** Agent harness for error messages (e.g. "claude", "codex-sdk") */
  agentHarness: AgentHarness;
  /** Human-readable name for log messages (e.g. "Claude", "Codex") */
  displayName: string;
  /** Env var override (e.g. "CLAUDE_CLI_PATH", "CODEX_CLI_PATH") */
  envVar?: string;
  /** Env var overrides in priority order. */
  envVars?: string[];
  /** Static candidate paths (bundled/runtime install locations) */
  staticCandidates: string[];
  /** Version flag to verify the candidate (e.g. "-v", "--version") */
  versionFlag: string;
  /**
   * Optional: validate the version output for a candidate. Returning false
   * makes discovery continue to the next candidate instead of accepting it.
   */
  validateVersion?: (
    versionOutput: string,
    candidate: string
  ) => { success: boolean; error?: string };
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
 * 1. Gather candidates: env var(s) → static bundled/runtime paths
 * 2. For each candidate: verify it exists, run `<candidate> <versionFlag>`
 * 3. First success wins; all failures produce a descriptive error.
 */
export function discoverExecutable(
  config: DiscoveryConfig,
  state: DiscoveryState
): { success: boolean; error?: string } {
  console.log(`Setting up ${config.displayName} executable path...`);

  const candidates: string[] = [];

  for (const envVar of getEnvVarNames(config)) {
    pushCandidate(candidates, process.env[envVar]);
  }

  for (const candidate of config.staticCandidates) {
    pushCandidate(candidates, candidate);
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
      const validation = config.validateVersion?.(version, candidate);
      if (validation && !validation.success) {
        triedCandidates.push(validation.error ? `${candidate} (${validation.error})` : candidate);
        continue;
      }
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

  const triedList = triedCandidates.length > 0 ? triedCandidates.join(", ") : "(none)";
  const errorMessage = `Failed to find ${config.displayName} executable. Tried: ${triedList}`;
  console.error(`${config.displayName} executable initialization failed: ${errorMessage}`);
  state.result = { success: false, error: errorMessage };
  return { success: false, error: errorMessage };
}

function getEnvVarNames(config: DiscoveryConfig): string[] {
  const names = [...(config.envVars ?? [])];
  if (config.envVar) names.push(config.envVar);
  return Array.from(new Set(names));
}

function pushCandidate(candidates: string[], candidate: string | undefined): void {
  if (!candidate || candidates.includes(candidate)) return;
  candidates.push(candidate);
}

function verifyCandidate(candidate: string, versionFlag: string): string {
  const opts = {
    encoding: "utf-8" as const,
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };

  // Candidate must be a directly executable file. Bundled agent CLIs are native
  // binaries; custom overrides should point at an executable wrapper or binary,
  // not a raw JS module that requires us to discover another runtime.
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
