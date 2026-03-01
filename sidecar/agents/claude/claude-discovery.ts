// sidecar/agents/claude/claude-init.ts
// Claude executable discovery and initialization state.

import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { FrontendClient } from "../../frontend-client";

// ============================================================================
// State
// ============================================================================

let pathToClaudeCodeExecutable = "";
let initializationResult: {
  success: boolean;
  path?: string;
  error?: string;
} | null = null;

// ============================================================================
// Public API
// ============================================================================

/** Returns the discovered Claude CLI executable path. */
export function getClaudeExecutablePath(): string {
  return pathToClaudeCodeExecutable;
}

/**
 * Discovers and verifies the Claude executable.
 * Called once at sidecar startup.
 */
export function initializeClaude(): { success: boolean; error?: string } {
  console.log("Setting up Claude executable path...");

  // Static candidate paths (known install locations)
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    path.join(path.dirname(process.argv[1]), "claude"),
    "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
  ].filter(Boolean) as string[];

  // Dynamic discovery: find claude via user's shell PATH.
  // Node's child_process inherits a minimal env, so run through login shell
  // to pick up ~/.local/bin, nvm paths, etc.
  // Strip node_modules/.bin from PATH to avoid finding the SDK's internal
  // CLI wrapper (which crashes on `claude -v` in bundled/test contexts).
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const cleanEnv = { ...process.env };
    if (cleanEnv.PATH) {
      cleanEnv.PATH = cleanEnv.PATH.split(":")
        .filter((p) => !p.includes("node_modules"))
        .join(":");
    }
    const resolved = execSync(`"${shell}" -l -c "command -v claude"`, {
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

  const triedCandidates: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;

    // Avoid shell noise when absolute/relative paths are missing.
    const looksLikePath = candidate.includes(path.sep) || candidate.startsWith(".");
    if (looksLikePath && !fs.existsSync(candidate)) {
      triedCandidates.push(candidate);
      continue;
    }

    try {
      const version = verifyClaudeCandidate(candidate);
      console.log(`Claude executable initialized with version: ${version} at ${candidate}`);
      pathToClaudeCodeExecutable = candidate;
      initializationResult = { success: true, path: candidate };
      return { success: true };
    } catch {
      triedCandidates.push(candidate);
      // Try next candidate
    }
  }

  const errorMessage = `Failed to find Claude executable. Tried: ${triedCandidates.join(", ")}`;
  console.error(`Claude executable initialization failed: ${errorMessage}`);
  initializationResult = { success: false, error: errorMessage };
  return { success: false, error: errorMessage };
}

function verifyClaudeCandidate(candidate: string): string {
  const escaped = candidate.replaceAll('"', '\\"');

  // JS entrypoint installed via a global package manager.
  if (candidate.endsWith(".js")) {
    return execSync(`node "${escaped}" -v`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  // Native binary/symlink.
  return execSync(`"${escaped}" -v`, {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Checks if initialization succeeded, and sends an error to the frontend if not.
 * Returns true if blocked (initialization failed), false if OK to proceed.
 */
export function blockIfNotInitialized(sessionId: string): boolean {
  if (!initializationResult?.success) {
    FrontendClient.sendError({
      id: sessionId,
      type: "error",
      error: `Cannot process request: ${initializationResult?.error || "Initialization failed"}`,
      agentType: "claude",
      category: "internal",
    });
    console.log("Blocked request due to initialization failure");
    return true;
  }
  return false;
}
