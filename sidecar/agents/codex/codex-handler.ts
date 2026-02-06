// sidecar/agents/codex/codex-handler.ts
// CodexAgentHandler — implements AgentHandler for the Codex CLI.
//
// Unlike Claude (long-lived async generator), Codex is stateless per query:
// 1. Discovers the codex binary via CONDUCTOR_BIN_DIR or vendor path
// 2. Spawns `codex exec --experimental-json` as a child process per query
// 3. Reads JSON-line ThreadEvents from stdout via readline
// 4. Normalizes events through codex-adapter into ContentBlock[]
// 5. Persists to DB and streams to frontend

import { spawn, execSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

import { FrontendClient } from "../../frontend-client";
import { saveAssistantMessage, updateSessionStatus } from "../../db/session-writer";
import { buildAgentEnvironment, parseEnvString } from "../env-builder";
import { createCodexTransformer } from "./codex-adapter";
import type { CodexEvent } from "./codex-adapter";
import type { AgentHandler, QueryOptions } from "../agent-handler";

// ============================================================================
// Codex binary discovery
// ============================================================================

let codexExecutablePath: string | null = null;

/** Platforms where Codex is supported. Avoids silently mapping unsupported platforms. */
const SUPPORTED_PLATFORMS: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
};

/**
 * Discover the Codex CLI binary.
 *
 * Search order:
 * 1. CONDUCTOR_BIN_DIR env var (production: bundled with OpenDevs.app)
 * 2. Vendor directory relative to the bundled sidecar script
 * 3. PATH lookup via `which codex`
 */
function discoverCodexBinary(): string | null {
  // 1. CONDUCTOR_BIN_DIR (production OpenDevs.app bundle)
  const binDir = process.env.CONDUCTOR_BIN_DIR;
  if (binDir) {
    const bundledPath = path.join(binDir, "codex");
    if (fs.existsSync(bundledPath)) {
      console.log(`[CODEX] Found codex binary at CONDUCTOR_BIN_DIR: ${bundledPath}`);
      return bundledPath;
    }
  }

  // 2. Vendor directory relative to the sidecar script (bundle-safe)
  // Uses process.argv[1] instead of __dirname because esbuild bundles the sidecar
  // into a single CJS file — __dirname would resolve to the bundle output directory,
  // not the original source tree. process.argv[1] gives the actual script path.
  const platformKey = SUPPORTED_PLATFORMS[process.platform];
  if (platformKey) {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const scriptDir = path.dirname(process.argv[1] || "");
    const vendorPath = path.resolve(scriptDir, `../../vendor/${platformKey}-${arch}/codex/codex`);
    if (fs.existsSync(vendorPath)) {
      console.log(`[CODEX] Found codex binary at vendor path: ${vendorPath}`);
      return vendorPath;
    }
  } else {
    console.log(`[CODEX] Platform '${process.platform}' is not supported for Codex vendor lookup`);
  }

  // 3. PATH lookup (fallback)
  try {
    const whichResult = execSync("which codex", { encoding: "utf-8" }).trim();
    if (whichResult && fs.existsSync(whichResult)) {
      console.log(`[CODEX] Found codex binary in PATH: ${whichResult}`);
      return whichResult;
    }
  } catch {
    // Not found in PATH
  }

  return null;
}

// ============================================================================
// Session state (minimal — only for cancellation)
// ============================================================================

interface CodexSessionState {
  controller: AbortController;
  childProcess?: ChildProcess;
  turnId?: string;
  cwd: string;
  threadId?: string;
}

const activeSessions = new Map<string, CodexSessionState>();

// ============================================================================
// Auth error detection
// ============================================================================

const AUTH_ERROR_KEYWORDS = ["unauthorized", "authentication", "api key", "401"];

function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_ERROR_KEYWORDS.some((keyword) => lower.includes(keyword));
}

// ============================================================================
// CodexAgentHandler
// ============================================================================

export class CodexAgentHandler implements AgentHandler {
  readonly agentType = "codex" as const;

  initialize(): { success: boolean; error?: string } {
    codexExecutablePath = discoverCodexBinary();
    if (!codexExecutablePath) {
      // Codex is optional — not having it isn't a fatal error
      console.log("[CODEX] Codex binary not found. Codex agent will be unavailable.");
      return { success: true }; // Still register, but queries will fail gracefully
    }
    console.log(`[CODEX] Initialized with binary: ${codexExecutablePath}`);
    return { success: true };
  }

  async handleQuery(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    console.log(`[CODEX] Handling query for session: ${sessionId}`);

    if (!codexExecutablePath) {
      FrontendClient.sendError({
        id: sessionId,
        type: "error",
        error: "Codex binary not found. Please install Codex or ensure CONDUCTOR_BIN_DIR is set.",
        agentType: "codex",
      });
      updateSessionStatus(sessionId, "error");
      return;
    }

    // Cancel any existing query for this session
    this.cancelSession(sessionId);

    const controller = new AbortController();
    const sessionState: CodexSessionState = {
      controller,
      turnId: options.turnId,
      cwd: options.cwd,
    };
    activeSessions.set(sessionId, sessionState);

    // Fire and forget — Codex queries are stateless
    void this.executeCodexQuery(sessionId, prompt, options, sessionState);
  }

  async handleCancel(sessionId: string): Promise<void> {
    console.log(`[CODEX] Handling cancel for session: ${sessionId}`);
    this.cancelSession(sessionId);
    updateSessionStatus(sessionId, "idle");
  }

  handleReset(sessionId: string): void {
    console.log(`[CODEX] Handling reset for session: ${sessionId}`);
    this.cancelSession(sessionId);
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  private cancelSession(sessionId: string): void {
    const session = activeSessions.get(sessionId);
    if (session) {
      session.controller.abort();
      if (session.childProcess && !session.childProcess.killed) {
        session.childProcess.kill("SIGTERM");
      }
      activeSessions.delete(sessionId);
    }
  }

  private async executeCodexQuery(
    sessionId: string,
    prompt: string,
    options: QueryOptions,
    sessionState: CodexSessionState
  ): Promise<void> {
    const env = buildAgentEnvironment({
      claudeEnvVars: options.claudeEnvVars,
      conductorEnv: options.conductorEnv,
      ghToken: options.ghToken,
    });

    // Build command arguments
    const args = ["exec", "--experimental-json"];

    // Add model if specified
    if (options.model) {
      const envVars = options.claudeEnvVars ? parseEnvString(options.claudeEnvVars) : {};
      const model = this.mapCodexModel(options.model, envVars);
      if (model) {
        args.push("--model", model);
      }
    }

    // Add working directory
    args.push("--cwd", options.cwd);

    console.log(`[CODEX] Spawning: ${codexExecutablePath} ${args.join(" ")}`);

    const child = spawn(codexExecutablePath!, args, {
      env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: sessionState.controller.signal,
    });

    sessionState.childProcess = child;

    // Write prompt to stdin then close
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    // Guard against missing stdout (e.g., if spawn fails due to permissions)
    if (!child.stdout) {
      const errorMsg = "Codex process has no stdout — binary may not be executable";
      console.error(`[CODEX] ${errorMsg}`);
      FrontendClient.sendError({
        id: sessionId,
        type: "error",
        error: errorMsg,
        agentType: "codex",
      });
      updateSessionStatus(sessionId, "error");
      return;
    }

    // Create adapter transformer for normalizing Codex events
    const transformer = createCodexTransformer();

    // Buffer stderr for error reporting
    let stderrBuffer = "";
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderrBuffer += data.toString();
      });
    }

    // Read JSON lines from stdout
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (sessionState.controller.signal.aborted) break;

        const trimmed = line.trim();
        if (!trimmed) continue;

        let rawEvent: { event?: CodexEvent; thread_id?: string };
        try {
          rawEvent = JSON.parse(trimmed);
        } catch {
          console.error(`[CODEX] Failed to parse JSON line: ${trimmed.substring(0, 200)}`);
          continue;
        }

        // Capture thread_id for message correlation (Issue #10)
        if (rawEvent.thread_id && !sessionState.threadId) {
          sessionState.threadId = rawEvent.thread_id;
        }

        // Codex wraps events in { event: {...}, thread_id: "..." }
        const event = rawEvent.event ?? (rawEvent as unknown as CodexEvent);
        if (!event || !event.type) continue;

        // Process through adapter for normalization
        transformer.process(event);

        // Forward raw event to frontend for streaming UI
        FrontendClient.sendMessage({
          id: sessionId,
          type: "message",
          agentType: "codex",
          data: rawEvent,
        });
      }

      // Wait for the child process to exit
      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
        } else {
          child.on("exit", (code) => resolve(code));
        }
      });

      // Finalize the transformer to get all accumulated blocks + usage
      const result = transformer.finish();

      if (result.error || (exitCode !== null && exitCode !== 0)) {
        const errorMsg =
          result.error || stderrBuffer.trim() || `Codex exited with code ${exitCode}`;

        if (isAuthError(errorMsg)) {
          FrontendClient.sendError({
            id: sessionId,
            type: "error",
            error: `Codex authentication failed. Run 'codex login' or set the OPENAI_API_KEY environment variable.`,
            agentType: "codex",
          });
        } else {
          FrontendClient.sendError({
            id: sessionId,
            type: "error",
            error: errorMsg,
            agentType: "codex",
          });
        }

        updateSessionStatus(sessionId, "error");
      } else {
        // Persist the accumulated normalized message to database
        if (result.blocks.length > 0) {
          const model = options.model || "codex";
          saveAssistantMessage(
            sessionId,
            { id: sessionState.threadId, content: result.blocks },
            model,
            { blocks: result.blocks, usage: result.usage }
          );
        }

        updateSessionStatus(sessionId, "idle");
        console.log(`[CODEX] Query completed for session ${sessionId}`);
      }
    } catch (error) {
      if (sessionState.controller.signal.aborted) {
        // Cancelled — expected, just clean up
        console.log(`[CODEX] Query cancelled for session ${sessionId}`);
        updateSessionStatus(sessionId, "idle");
      } else {
        console.error(`[CODEX] Error in query for session ${sessionId}:`, error);
        FrontendClient.sendError({
          id: sessionId,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
          agentType: "codex",
        });
        updateSessionStatus(sessionId, "error");
      }
    } finally {
      // Only clean up if this query still owns the session.
      // A rapid cancel + re-query can replace the session before this finally runs;
      // blindly deleting would wipe the new session's state (same guard as Claude handler).
      const currentSession = activeSessions.get(sessionId);
      if (currentSession === sessionState) {
        activeSessions.delete(sessionId);
      }
    }
  }

  /**
   * Map generic model names to Codex-specific model identifiers.
   * Users may configure models via claudeEnvVars (CODEX_MODEL override).
   */
  private mapCodexModel(model: string, envVars: Record<string, string>): string | undefined {
    // Allow explicit override via env var
    if (envVars.CODEX_MODEL) return envVars.CODEX_MODEL;

    // Pass through Codex/OpenAI model names as-is
    if (model.startsWith("o") || model.startsWith("gpt-")) return model;

    // Default: let Codex CLI use its own default
    return undefined;
  }
}
