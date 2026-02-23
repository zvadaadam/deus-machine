// sidecar/agents/codex/codex-discovery.ts
// Codex CLI executable discovery and initialization state.
// Mirrors claude-discovery.ts pattern for consistent agent bootstrapping.

import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { FrontendClient } from "../../frontend-client";

// ============================================================================
// State
// ============================================================================

let pathToCodexExecutable = "";
let initializationResult: {
  success: boolean;
  path?: string;
  error?: string;
} | null = null;

// ============================================================================
// Public API
// ============================================================================

/** Returns the discovered Codex CLI executable path. */
export function getCodexExecutablePath(): string {
  return pathToCodexExecutable;
}

/**
 * Discovers and verifies the Codex executable.
 * Called once at sidecar startup.
 *
 * Discovery order:
 * 1. CODEX_CLI_PATH env var (explicit override)
 * 2. SDK's bundled binary (via require.resolve)
 * 3. Dynamic shell PATH discovery (command -v codex)
 * 4. Known install paths (homebrew, npm global)
 */
export function initializeCodex(): { success: boolean; error?: string } {
  console.log("Setting up Codex executable path...");

  // Static candidate paths (known install locations)
  const candidates = [
    process.env.CODEX_CLI_PATH,
    "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
  ].filter(Boolean) as string[];

  // Try to find the binary bundled with @openai/codex npm package
  try {
    const codexPkgPath = require.resolve("@openai/codex/package.json");
    const codexDir = path.dirname(codexPkgPath);
    const binPath = path.join(codexDir, "bin", "codex.js");
    if (fs.existsSync(binPath) && !candidates.includes(binPath)) {
      candidates.push(binPath);
    }
  } catch {
    // @openai/codex not installed as a direct dependency
  }

  // Dynamic discovery: find codex via user's shell PATH
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const cleanEnv = { ...process.env };
    if (cleanEnv.PATH) {
      cleanEnv.PATH = cleanEnv.PATH.split(":")
        .filter((p) => !p.includes("node_modules"))
        .join(":");
    }
    const resolved = execSync(`"${shell}" -l -c "command -v codex"`, {
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

    // Avoid shell noise when absolute/relative paths are missing
    const looksLikePath = candidate.includes(path.sep) || candidate.startsWith(".");
    if (looksLikePath && !fs.existsSync(candidate)) {
      triedCandidates.push(candidate);
      continue;
    }

    try {
      const version = verifyCodexCandidate(candidate);
      console.log(`Codex executable initialized with version: ${version} at ${candidate}`);
      pathToCodexExecutable = candidate;
      initializationResult = { success: true, path: candidate };
      return { success: true };
    } catch {
      triedCandidates.push(candidate);
    }
  }

  const errorMessage = `Failed to find Codex executable. Tried: ${triedCandidates.join(", ")}`;
  console.error(`Codex executable initialization failed: ${errorMessage}`);
  initializationResult = { success: false, error: errorMessage };
  return { success: false, error: errorMessage };
}

function verifyCodexCandidate(candidate: string): string {
  const escaped = candidate.replaceAll('"', '\\"');

  // JS entrypoint installed via a global package manager
  if (candidate.endsWith(".js")) {
    return execSync(`node "${escaped}" --version`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  // Native binary/symlink
  return execSync(`"${escaped}" --version`, {
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
      error: `Cannot process Codex request: ${initializationResult?.error || "Codex initialization failed. Is codex CLI installed?"}`,
      agentType: "codex",
      category: "internal",
      willRetry: false,
    });
    console.log("Blocked Codex request due to initialization failure");
    return true;
  }
  return false;
}
