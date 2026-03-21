// Thin wrapper around the agent-browser CLI.
// Executes commands via child_process and parses JSON responses.
// The daemon auto-starts on the first command per session and maintains
// browser state (refs, cookies, DOM) across calls.

import { execFile } from "child_process";
import { join } from "path";

export interface AgentBrowserResult {
  success: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
}

// Resolve the binary once at module load.
// The npm package has a Node.js wrapper at bin/agent-browser.js that selects
// the correct platform binary. We resolve it relative to the package directory
// since the package has no "main" field (require.resolve would throw).
const BINARY = (() => {
  try {
    const pkgDir = require.resolve("agent-browser/package.json").replace(/\/package\.json$/, "");
    return join(pkgDir, "bin", "agent-browser.js");
  } catch {
    return "agent-browser"; // fallback to PATH
  }
})();

const DEFAULT_TIMEOUT_MS = 35_000;

/**
 * Execute an agent-browser command for a given session.
 * The daemon auto-starts on first invocation and stays alive
 * for subsequent calls within the same session.
 */
export async function execAgentBrowser(
  sessionId: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<AgentBrowserResult> {
  const env = {
    ...process.env,
    AGENT_BROWSER_SESSION: sessionId,
    AGENT_BROWSER_HEADED: "1",
  };

  return new Promise<AgentBrowserResult>((resolve, reject) => {
    const child = execFile(
      BINARY,
      args,
      { env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(stderr || error.message));
          return;
        }

        // agent-browser prints JSON to stdout when invoked from daemon
        const output = stdout.trim();
        if (!output) {
          resolve({ success: true, data: null, error: null });
          return;
        }

        // Try to parse the last JSON line (agent-browser may print status lines before JSON)
        const lines = output.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith("{")) {
            try {
              const parsed = JSON.parse(line);
              resolve({
                success: parsed.success !== false,
                data: parsed.data ?? parsed,
                error: parsed.error ?? null,
              });
              return;
            } catch {
              continue;
            }
          }
        }

        // No JSON found — treat raw output as text data
        resolve({ success: true, data: { text: output }, error: null });
      }
    );

    // Prevent zombie processes
    child.on("error", (err) => reject(err));
  });
}

/**
 * Execute an agent-browser command and return the snapshot text (accessibility tree).
 * Used after actions that return a snapshot (click, type, navigate, scroll, etc.)
 */
export async function execWithSnapshot(
  sessionId: string,
  args: string[],
  timeoutMs?: number
): Promise<{ snapshot?: string; url?: string; title?: string; error?: string }> {
  try {
    const result = await execAgentBrowser(sessionId, args, timeoutMs);
    if (!result.success) {
      return { error: result.error || "Unknown error" };
    }

    // After an action, take a snapshot to return to the agent
    const snapResult = await execAgentBrowser(sessionId, ["snapshot", "--json"], timeoutMs);
    if (!snapResult.success) {
      return { error: `Action succeeded but snapshot failed: ${snapResult.error || "unknown"}` };
    }
    const snapshot = (snapResult.data?.snapshot as string) || (snapResult.data?.text as string);

    // Get current URL and title (best-effort, don't fail if these error)
    const urlResult = await execAgentBrowser(sessionId, ["get", "url", "--json"]).catch(() => null);
    const titleResult = await execAgentBrowser(sessionId, ["get", "title", "--json"]).catch(
      () => null
    );

    return {
      snapshot,
      url: (urlResult?.data?.url as string) || (urlResult?.data?.text as string),
      title: (titleResult?.data?.title as string) || (titleResult?.data?.text as string),
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Get a snapshot with URL and title in one go.
 * Used by BrowserSnapshot tool.
 */
export async function getSnapshot(
  sessionId: string,
  timeoutMs?: number
): Promise<{ snapshot?: string; url?: string; title?: string; error?: string }> {
  try {
    const snapResult = await execAgentBrowser(sessionId, ["snapshot", "--json"], timeoutMs);
    if (!snapResult.success) {
      return { error: snapResult.error || "Snapshot failed" };
    }

    const snapshot = (snapResult.data?.snapshot as string) || (snapResult.data?.text as string);

    const urlResult = await execAgentBrowser(sessionId, ["get", "url", "--json"]).catch(() => null);
    const titleResult = await execAgentBrowser(sessionId, ["get", "title", "--json"]).catch(
      () => null
    );

    return {
      snapshot,
      url: (urlResult?.data?.url as string) || (urlResult?.data?.text as string),
      title: (titleResult?.data?.title as string) || (titleResult?.data?.text as string),
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
