// agent-server/agents/environment/cli-discovery.ts
// Generic CLI executable discovery for all agent handlers.
// Each agent provides a DiscoveryConfig describing what to find;
// this module handles the deterministic override/bundled verification flow.

import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { getBundledCliPathCandidates, resolveBundledCliPath } from "@shared/lib/cli-path";
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
  /** Env var override paths (e.g. "CLAUDE_CLI_PATH", "CODEX_CLI_PATH") */
  envVars: string[];
  /** Bundled executable name inside Resources/bin or staged dist/runtime bin. */
  bundledTool: "claude" | "codex";
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

interface Candidate {
  path: string;
  source: "override" | "bundled";
}

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".ps1", ".com"]);

// ============================================================================
// Discovery Algorithm
// ============================================================================

/**
 * Discovers and verifies a CLI executable using the given config.
 * Mutates `state` with the result.
 *
 * Algorithm:
 * 1. Gather candidates: explicit env override path(s) → bundled runtime path
 * 2. For each candidate: verify it exists; custom overrides also run `<candidate> <versionFlag>`
 * 3. First success wins; all failures produce a descriptive error.
 */
export function discoverExecutable(
  config: DiscoveryConfig,
  state: DiscoveryState
): { success: boolean; error?: string } {
  console.log(`Setting up ${config.displayName} executable path...`);

  const candidates: Candidate[] = [];

  for (const envVar of config.envVars) {
    const envOverride = process.env[envVar];
    if (envOverride) candidates.push({ path: envOverride, source: "override" });
  }

  const bundledCandidate = resolveBundledCliPath(config.bundledTool);
  if (bundledCandidate) candidates.push({ path: bundledCandidate, source: "bundled" });

  const triedCandidates: string[] = [];
  const seenCandidates = new Set<string>();
  for (const candidate of candidates) {
    if (seenCandidates.has(candidate.path)) continue;
    seenCandidates.add(candidate.path);

    const candidatePath = candidate.path;

    if (!isPathCandidate(candidatePath)) {
      triedCandidates.push(`${candidatePath} (custom overrides must be executable paths)`);
      continue;
    }

    if (candidatePath.endsWith(".js")) {
      triedCandidates.push(`${candidatePath} (JavaScript CLI wrappers are not supported)`);
      continue;
    }

    if (!fs.existsSync(candidatePath)) {
      triedCandidates.push(`${candidatePath} (missing)`);
      continue;
    }

    const executableProblem = getExecutableFileProblem(candidatePath);
    if (executableProblem) {
      triedCandidates.push(`${candidatePath} (${executableProblem})`);
      continue;
    }

    if (candidate.source === "bundled") {
      // Bundled binaries are version-verified while staging/packaging the runtime.
      // Runtime startup should not block on executing them just to rediscover the
      // same locked package version.
      console.log(
        `${config.displayName} executable initialized at ${candidatePath} (bundled runtime)`
      );
      if (process.env.DEUS_RUNTIME === "1" || process.env.DEUS_PACKAGED === "1") {
        process.stdout.write(`BUNDLED_CLI_PATH ${config.bundledTool}=${candidatePath}\n`);
      }
      state.executablePath = candidatePath;
      state.result = { success: true, path: candidatePath };
      return { success: true };
    }

    try {
      const version = verifyCandidate(candidatePath, config.versionFlag);
      const validation = config.validateVersion?.(version, candidatePath);
      if (validation && !validation.success) {
        triedCandidates.push(
          validation.error ? `${candidatePath} (${validation.error})` : candidatePath
        );
        continue;
      }
      console.log(
        `${config.displayName} executable initialized with version: ${version} at ${candidatePath}`
      );
      state.executablePath = candidatePath;
      state.result = { success: true, path: candidatePath };
      return { success: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      triedCandidates.push(`${candidatePath} (${detail})`);
    }
  }

  const expectedBundled = getBundledCliPathCandidates(config.bundledTool);
  for (const candidate of expectedBundled) {
    if (
      !seenCandidates.has(candidate) &&
      !triedCandidates.some((tried) => tried.startsWith(candidate))
    ) {
      triedCandidates.push(`${candidate} (missing)`);
    }
  }

  const errorMessage = `Failed to initialize ${config.displayName} executable. Tried: ${triedCandidates.join(", ")}`;
  console.error(`${config.displayName} executable initialization failed: ${errorMessage}`);
  state.result = { success: false, error: errorMessage };
  return { success: false, error: errorMessage };
}

function isPathCandidate(candidate: string): boolean {
  return path.isAbsolute(candidate) || candidate.startsWith(".") || candidate.includes(path.sep);
}

function getExecutableFileProblem(candidate: string): string | null {
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) return "not a regular file";
  if (process.platform === "win32") {
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.extname(candidate).toLowerCase())
      ? null
      : "not a recognized Windows executable";
  }
  return (stat.mode & 0o111) !== 0 ? null : "not executable";
}

function verifyCandidate(candidate: string, versionFlag: string): string {
  return execFileSync(candidate, [versionFlag], {
    encoding: "utf-8" as const,
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: [path.dirname(candidate), process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  }).trim();
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
