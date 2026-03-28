// Thin wrapper around the agent-browser CLI.
// Executes commands via child_process and parses JSON responses.
// The daemon auto-starts on the first command per session and maintains
// browser state (refs, cookies, DOM) across calls.

import { execFile, spawn } from "child_process";
import { dirname, join } from "path";

export interface AgentBrowserResult {
  success: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Resolve the binary once at module load.
// The npm package has a Node.js wrapper at bin/agent-browser.js that selects
// the correct platform binary. We resolve it relative to the package directory
// since the package has no "main" field (require.resolve would throw).
// Note: agent-server is bundled to CJS, so require.resolve is available.
const BINARY = (() => {
  try {
    const pkgDir = dirname(require.resolve("agent-browser/package.json"));
    return join(pkgDir, "bin", "agent-browser.js");
  } catch {
    return "agent-browser"; // fallback to PATH
  }
})();

const DEFAULT_TIMEOUT_MS = 35_000;

/**
 * When CDP_PORT is set (Electron desktop mode), agent-browser connects to the
 * IDE's own BrowserView via Chrome DevTools Protocol instead of spawning a
 * separate Chrome process. This means:
 * - Agent and user see the same browser (shared cookies, real-time visibility)
 * - No separate Chrome daemon to manage
 * - `--cdp <port>` is prepended to all agent-browser commands
 */
const CDP_PORT = process.env.CDP_PORT;

/** Build final args with optional CDP prefix */
function buildArgs(args: string[]): string[] {
  return CDP_PORT ? ["--cdp", CDP_PORT, ...args] : args;
}

/** Build env for agent-browser subprocess */
function buildEnv(sessionId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BROWSER_SESSION: sessionId,
    AGENT_BROWSER_HEADED: "1",
  };
}

/** Parse the last JSON object from stdout (agent-browser may print status lines before JSON) */
function parseJsonFromOutput(output: string): AgentBrowserResult | null {
  if (!output) return null;
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          return { success: true, data: { results: parsed }, error: null };
        }
        return {
          success: parsed.success !== false,
          data: parsed.data ?? parsed,
          error: parsed.error ?? null,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Execute an agent-browser command for a given session.
 */
export async function execAgentBrowser(
  sessionId: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<AgentBrowserResult> {
  const finalArgs = buildArgs(args);
  const env = buildEnv(sessionId);

  return new Promise<AgentBrowserResult>((resolve, reject) => {
    const child = execFile(
      BINARY,
      finalArgs,
      { env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = stdout.trim();
        const parsed = parseJsonFromOutput(output);
        if (parsed) {
          resolve(parsed);
          return;
        }

        if (error) {
          resolve({
            success: false,
            data: output ? { text: output } : null,
            error: stderr || error.message,
          });
          return;
        }

        if (!output) {
          resolve({ success: true, data: null, error: null });
          return;
        }

        resolve({ success: true, data: { text: output }, error: null });
      }
    );

    child.on("error", (err) => reject(err));
  });
}

/**
 * Execute an agent-browser command with stdin input (used for batch mode).
 * Uses spawn instead of execFile to pipe stdin data.
 */
export async function execAgentBrowserWithStdin(
  sessionId: string,
  args: string[],
  stdinData: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<AgentBrowserResult> {
  const finalArgs = buildArgs(args);
  const env = buildEnv(sessionId);

  return new Promise<AgentBrowserResult>((resolve, reject) => {
    const child = spawn(BINARY, finalArgs, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        resolve({ success: false, data: null, error: "Batch timed out" });
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const output = stdout.trim();
      const parsed = parseJsonFromOutput(output);
      if (parsed) {
        resolve(parsed);
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          data: output ? { text: output } : null,
          error: stderr || `Process exited with code ${code}`,
        });
        return;
      }

      resolve({ success: true, data: output ? { text: output } : null, error: null });
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    // Write stdin data and close
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/**
 * Get an element's bounding box (best-effort, returns null on failure).
 * Used for screen recording cursor animation.
 */
export async function getElementBox(sessionId: string, ref: string): Promise<ElementBox | null> {
  try {
    const result = await execAgentBrowser(sessionId, ["get", "box", ref, "--json"], 5_000);
    if (!result.success || !result.data) return null;
    const d = result.data;
    if (typeof d.x === "number" && typeof d.y === "number") {
      return {
        x: d.x as number,
        y: d.y as number,
        width: (d.width as number) || 0,
        height: (d.height as number) || 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Execute a batch of agent-browser commands in a single call.
 * Uses stdin-based batch mode for 10x fewer round-trips.
 *
 * Example: executeBatch(sessionId, [["click", "@e1"], ["fill", "@e3", "hello"]])
 */
export async function executeBatch(
  sessionId: string,
  commands: string[][],
  options?: { bail?: boolean; timeoutMs?: number }
): Promise<AgentBrowserResult> {
  const args = ["batch", "--json"];
  if (options?.bail) args.push("--bail");
  const stdinData = JSON.stringify(commands);
  return execAgentBrowserWithStdin(
    sessionId,
    args,
    stdinData,
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
}

/**
 * Execute an agent-browser command and return snapshot + metadata.
 * Optionally fetches element bounding box for screen recording.
 *
 * Performance: snapshot, url, title, and box are fetched concurrently
 * via Promise.all (saves ~150ms vs sequential).
 */
export async function execWithSnapshot(
  sessionId: string,
  args: string[],
  timeoutMs?: number,
  interactedRef?: string
): Promise<{
  snapshot?: string;
  url?: string;
  title?: string;
  error?: string;
  elementBox?: ElementBox | null;
}> {
  try {
    const result = await execAgentBrowser(sessionId, args, timeoutMs);
    if (!result.success) {
      return { error: result.error || "Unknown error" };
    }

    // Fetch metadata concurrently — all are independent read-only queries
    const [snapResult, urlResult, titleResult, box] = await Promise.all([
      execAgentBrowser(sessionId, ["snapshot", "--json"], timeoutMs),
      execAgentBrowser(sessionId, ["get", "url", "--json"]).catch(() => null),
      execAgentBrowser(sessionId, ["get", "title", "--json"]).catch(() => null),
      interactedRef ? getElementBox(sessionId, interactedRef) : Promise.resolve(null),
    ]);

    if (!snapResult.success) {
      return { error: `Action succeeded but snapshot failed: ${snapResult.error || "unknown"}` };
    }

    return {
      snapshot: (snapResult.data?.snapshot as string) || (snapResult.data?.text as string),
      url: (urlResult?.data?.url as string) || (urlResult?.data?.text as string),
      title: (titleResult?.data?.title as string) || (titleResult?.data?.text as string),
      elementBox: box,
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Get a snapshot with URL and title.
 * Supports optional filtering flags for smaller, more focused snapshots.
 */
export async function getSnapshot(
  sessionId: string,
  timeoutMs?: number,
  options?: {
    interactive?: boolean;
    compact?: boolean;
    depth?: number;
    selector?: string;
  }
): Promise<{ snapshot?: string; url?: string; title?: string; error?: string }> {
  try {
    const snapArgs = ["snapshot", "--json"];
    if (options?.interactive) snapArgs.push("-i");
    if (options?.compact) snapArgs.push("-c");
    if (options?.depth !== undefined) snapArgs.push("-d", String(options.depth));
    if (options?.selector) snapArgs.push("-s", options.selector);

    const [snapResult, urlResult, titleResult] = await Promise.all([
      execAgentBrowser(sessionId, snapArgs, timeoutMs),
      execAgentBrowser(sessionId, ["get", "url", "--json"]).catch(() => null),
      execAgentBrowser(sessionId, ["get", "title", "--json"]).catch(() => null),
    ]);

    if (!snapResult.success) {
      return { error: snapResult.error || "Snapshot failed" };
    }

    return {
      snapshot: (snapResult.data?.snapshot as string) || (snapResult.data?.text as string),
      url: (urlResult?.data?.url as string) || (urlResult?.data?.text as string),
      title: (titleResult?.data?.title as string) || (titleResult?.data?.text as string),
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
