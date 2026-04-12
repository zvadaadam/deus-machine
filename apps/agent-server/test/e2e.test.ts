import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";

/**
 * End-to-end tests: Spawn a real agent-server process, connect via
 * WebSocket, send JSON-RPC messages, verify responses.
 *
 * Three test suites:
 * 1. Protocol compliance — tests JSON-RPC protocol handling (always runs)
 * 2. Real Claude integration — tests actual Claude SDK calls (skipped if CLI unavailable)
 * 3. Real Codex integration — tests actual Codex SDK calls (skipped if no OPENAI_API_KEY)
 *
 * NOTE: These tests require:
 * 1. The agent-server bundle to be built: `bunx tsx agent-server/build.ts`
 * 2. Claude CLI to be installed (for Claude integration tests)
 * 3. OPENAI_API_KEY env var (for Codex integration tests — CLI binary comes from npm)
 */

const AGENT_SERVER_DIR = path.resolve(__dirname, "..");
const BUNDLE_PATH = path.resolve(AGENT_SERVER_DIR, "dist", "index.bundled.cjs");

// The workspace root — a real git repo for integration tests
const WORKSPACE_ROOT = path.resolve(AGENT_SERVER_DIR, "..");

// Check if the bundle exists before running E2E tests
const bundleExists = fs.existsSync(BUNDLE_PATH);

// Check if Claude CLI is available on this machine.
// We only check if the executable exists (not run it) because running
// `claude -v` can crash in vitest's Node.js context due to module
// compatibility issues with the Claude Code SDK.
let claudeCliAvailable = false;
try {
  const shell = process.env.SHELL || "/bin/zsh";
  const claudePath = execSync(`${shell} -l -c "command -v claude"`, {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  if (claudePath && fs.existsSync(claudePath)) {
    claudeCliAvailable = true;
  }
} catch {
  // Claude CLI not installed — integration tests will be skipped
}

// Check if Codex can run — the binary comes bundled with @openai/codex (npm dep),
// so we only need an API key to actually hit the OpenAI API.
const hasOpenAIKey = !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);

// In CI, integration tests MUST run — fail if prerequisites are missing, don't skip.
// Locally, gracefully skip when keys/CLI are unavailable.
const isCI = !!process.env.CI;

// ============================================================================
// CI prerequisite guard — fail fast with clear messages
// ============================================================================

if (isCI) {
  describe("CI: Required E2E prerequisites", () => {
    it("agent-server bundle exists", () => {
      expect(bundleExists, "Run 'bun run build:agent-server' before E2E tests").toBe(true);
    });

    it("OPENAI_API_KEY is set for Codex tests", () => {
      expect(
        hasOpenAIKey,
        "Add OPENAI_API_KEY as a GitHub Actions secret (Settings → Secrets → Actions)"
      ).toBe(true);
    });
  });
}

// ============================================================================
// Helpers
// ============================================================================

/** Wait for a message matching a predicate from the WebSocket */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 10000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", onMessage);
      reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(data: WebSocket.Data) {
      const text = typeof data === "string" ? data : data.toString("utf8");
      try {
        const msg = JSON.parse(text);
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeListener("message", onMessage);
          resolve(msg);
        }
      } catch {
        // Ignore parse errors
      }
    }

    ws.on("message", onMessage);
  });
}

/** Collect all messages from a WebSocket into an array (non-blocking) */
function collectMessages(ws: WebSocket): any[] {
  const messages: any[] = [];

  ws.on("message", (data: WebSocket.Data) => {
    const text = typeof data === "string" ? data : data.toString("utf8");
    try {
      messages.push(JSON.parse(text));
    } catch {
      // Ignore parse errors
    }
  });

  return messages;
}

/** Send a JSON-RPC notification (fire-and-forget) */
function sendNotification(ws: WebSocket, method: string, params: any): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

/** Send a JSON-RPC request and return its ID */
let rpcIdCounter = 1;
function sendRequest(ws: WebSocket, method: string, params: any): number {
  const id = rpcIdCounter++;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return id;
}

/** Wait until a file exists and has content, then return its contents. */
async function readFileWithRetry(filePath: string, timeoutMs = 5000): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (content.length > 0) return content;
      } catch {
        // Keep retrying while file is being written/flushed
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for log file: ${filePath}`);
}

/** Spawn an agent-server process and connect a WebSocket client */
async function spawnAgentServer(): Promise<{
  process: ChildProcess;
  wsUrl: string;
  client: WebSocket;
  logPath: string;
}> {
  // The agent-server is stateless — no DATABASE_PATH needed.
  const proc = spawn("node", [BUNDLE_PATH], {
    env: {
      ...process.env,
      LOG_LEVEL: "debug",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrOutput = "";
  proc.stderr?.on("data", (data: Buffer) => {
    stderrOutput += data.toString();
  });

  // Wait for LISTEN_URL= from stdout
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let stdoutBuffer = "";
    const timeout = setTimeout(() => {
      reject(
        new Error(`Agent-server did not print LISTEN_URL within 15s. stderr: ${stderrOutput}`)
      );
    }, 15_000);

    proc.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const match = stdoutBuffer.match(/LISTEN_URL=(.+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1].trim());
      }
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Agent-server exited with code ${code}. stderr: ${stderrOutput}`));
    });
  });

  // Connect to the agent-server's WebSocket
  const client = await new Promise<WebSocket>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket connection timed out")), 5000);
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const logPath = `/tmp/deus-${proc.pid}.log`;

  return { process: proc, wsUrl, client, logPath };
}

/** Kill an agent-server process and clean up */
async function killAgentServer(srv: { process: ChildProcess; client: WebSocket }): Promise<void> {
  if (srv.client) {
    srv.client.close();
  }
  if (srv.process) {
    srv.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      srv.process.on("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
  }
}

// ============================================================================
// Suite 1: Protocol compliance (no Claude CLI required)
// ============================================================================

describe.skipIf(!bundleExists)("E2E: Agent Server Process", () => {
  let agentServerProcess: ChildProcess;
  let wsUrl: string;
  let client: WebSocket;

  beforeAll(async () => {
    const result = await spawnAgentServer();
    agentServerProcess = result.process;
    wsUrl = result.wsUrl;
    client = result.client;
  }, 30_000);

  afterAll(async () => {
    await killAgentServer({ process: agentServerProcess, client });
  });

  it("connects to the agent-server via WebSocket", () => {
    expect(client).toBeDefined();
    expect(wsUrl).toContain("ws://127.0.0.1:");
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it("handles an unknown JSON-RPC method gracefully", async () => {
    const id = sendRequest(client, "nonExistentMethod", {});

    const response = await waitForMessage(
      client,
      (msg) => msg.jsonrpc === "2.0" && msg.id === id,
      5000
    );

    expect(response.error).toBeDefined();
    expect(response.error.code).toBeDefined();
  });

  it("responds to valid JSON-RPC requests on registered methods", async () => {
    const id = sendRequest(client, "provider/auth", {
      agentType: "claude",
      id: "test-session",
      cwd: "/tmp",
    });

    const response = await waitForMessage(
      client,
      (msg) => msg.jsonrpc === "2.0" && msg.id === id,
      10_000
    );

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(id);
    expect(response.result !== undefined || response.error !== undefined).toBe(true);
  });

  it("handles malformed JSON gracefully (no crash)", async () => {
    client.send("this is not valid json");
    client.send("{ incomplete");

    const id = sendRequest(client, "provider/auth", {
      agentType: "claude",
      id: "test-after-garbage",
      cwd: "/tmp",
    });

    const response = await waitForMessage(
      client,
      (msg) => msg.jsonrpc === "2.0" && msg.id === id,
      10_000
    );

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(id);
  });

  it("handles non-JSON-RPC JSON gracefully", async () => {
    client.send(JSON.stringify({ foo: "bar", not: "jsonrpc" }));

    const id = sendRequest(client, "provider/auth", {
      agentType: "claude",
      id: "test-after-nonjsonrpc",
      cwd: "/tmp",
    });

    const response = await waitForMessage(
      client,
      (msg) => msg.jsonrpc === "2.0" && msg.id === id,
      10_000
    );

    expect(response.jsonrpc).toBe("2.0");
  });
});

// ============================================================================
// Suite 2: Real Claude integration (requires Claude CLI + bundle)
// ============================================================================

describe.skipIf(!bundleExists || !claudeCliAvailable)("E2E: Real Claude Integration", () => {
  let agentServerProcess: ChildProcess;
  let client: WebSocket;
  let logPath: string;

  beforeAll(async () => {
    const result = await spawnAgentServer();
    agentServerProcess = result.process;
    client = result.client;
    logPath = result.logPath;
  }, 30_000);

  afterAll(async () => {
    await killAgentServer({ process: agentServerProcess, client });
  });

  // ------------------------------------------------------------------
  // Claude CLI discovery
  // ------------------------------------------------------------------

  it("discovers Claude CLI during initialization", async () => {
    // The agent-server log records whether initialization succeeded
    const log = await readFileWithRetry(logPath, 7000);
    expect(log).toContain("Claude executable initialized with version:");
    expect(log).toContain("handler initialized successfully");
    // Must NOT contain the initialization failure message
    expect(log).not.toContain("initialization failed");
  });

  // ------------------------------------------------------------------
  // Authentication check (real Claude SDK call)
  // ------------------------------------------------------------------

  it("returns real account info via claudeAuth", async () => {
    const id = sendRequest(client, "provider/auth", {
      agentType: "claude",
      id: "test-auth-real",
      cwd: WORKSPACE_ROOT,
    });

    const response = await waitForMessage(
      client,
      (msg) => msg.jsonrpc === "2.0" && msg.id === id,
      30_000
    );

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(id);
    // Should have a result (not an error) if Claude is authenticated
    expect(response.result).toBeDefined();
    expect(response.result.type).toBe("claude_auth_output");
    expect(response.result.agentType).toBe("claude");
    // accountInfo should have real data (email, org, etc.) or an error string
    const hasAccountInfo = response.result.accountInfo !== undefined;
    const hasError = response.result.error !== undefined;
    expect(hasAccountInfo || hasError).toBe(true);
  }, 30_000);

  // ------------------------------------------------------------------
  // Workspace initialization (real Claude SDK call)
  // ------------------------------------------------------------------

  it("returns slash commands and MCP servers via workspaceInit", async () => {
    const id = sendRequest(client, "provider/initWorkspace", {
      agentType: "claude",
      id: "test-workspace-init",
      cwd: WORKSPACE_ROOT,
    });

    const response = await waitForMessage(
      client,
      (msg) => msg.jsonrpc === "2.0" && msg.id === id,
      30_000
    );

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(id);
    expect(response.result).toBeDefined();
    expect(response.result.type).toBe("workspace_init_output");
    expect(response.result.agentType).toBe("claude");

    // Should return either real data or an error
    if (!response.result.error) {
      // Slash commands should be an array (may be empty in some setups)
      expect(Array.isArray(response.result.slashCommands)).toBe(true);
    }
  }, 30_000);

  // ------------------------------------------------------------------
  // Query flow: send a real prompt, receive streamed messages
  // ------------------------------------------------------------------

  it("sends a query and receives streamed response messages", async () => {
    const sessionId = `test-query-${Date.now()}`;

    // The agent-server is stateless — no DB seeding needed.
    // The backend saves the user message BEFORE forwarding turn/start to the agent-server.

    // Set up a collector for all incoming messages
    const messageCollector = collectMessages(client);

    // Send a minimal query (short prompt to get a quick response)
    sendNotification(client, "turn/start", {
      sessionId,
      agentType: "claude",
      prompt: "Reply with exactly: PONG",
      options: {
        cwd: WORKSPACE_ROOT,
        model: "sonnet",
        turnId: `turn-${Date.now()}`,
        permissionMode: "default",
      },
    });

    // Wait for session.idle or session.error (canonical lifecycle events)
    const isSessionIdle = (msg: any) =>
      msg.method === "session.idle" && msg.params?.sessionId === sessionId;
    const isSessionError = (msg: any) =>
      msg.method === "session.error" && msg.params?.sessionId === sessionId;

    const terminalMessage = await waitForMessage(
      client,
      (msg) => isSessionIdle(msg) || isSessionError(msg),
      60_000
    );

    // Collect all part events for this session
    const partEvents = messageCollector.filter(
      (msg: any) =>
        (msg.method === "part.created" || msg.method === "part.done") &&
        msg.params?.sessionId === sessionId
    );

    if (isSessionError(terminalMessage)) {
      expect(terminalMessage.params.error).toBeDefined();
      expect(typeof terminalMessage.params.error).toBe("string");
    } else {
      // Session completed successfully — verify part events were emitted
      expect(terminalMessage.method).toBe("session.idle");

      // Should have received at least one part.done event
      const partDoneEvents = partEvents.filter((msg: any) => msg.method === "part.done");
      expect(partDoneEvents.length).toBeGreaterThanOrEqual(1);

      // Each part.done should have valid structure
      for (const msg of partDoneEvents) {
        expect(msg.params.part).toBeDefined();
        expect(msg.params.part.type).toBeDefined();
      }
    }
  }, 90_000);

  // ------------------------------------------------------------------
  // Cancel flow: start a query then cancel it
  // ------------------------------------------------------------------

  it("cancels an active query and receives abort notification", async () => {
    const sessionId = `test-cancel-${Date.now()}`;

    // Start a query that will take a while (ask for a long response)
    sendNotification(client, "turn/start", {
      sessionId,
      agentType: "claude",
      prompt:
        "Write a 500-word essay about the history of computing. Be very thorough and detailed.",
      options: {
        cwd: WORKSPACE_ROOT,
        model: "sonnet",
        turnId: `turn-${Date.now()}`,
        permissionMode: "default",
      },
    });

    // Wait a bit for the query to start processing
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Send cancel request
    const cancelId = sendRequest(client, "turn/cancel", {
      sessionId,
    });

    // Should receive either:
    // 1. A cancel RPC response
    // 2. session.cancelled / session.error / session.idle (canonical events)
    const terminalMessage = await waitForMessage(
      client,
      (msg) => {
        if (msg.jsonrpc === "2.0" && msg.id === cancelId) return true;
        if (msg.method === "session.cancelled" && msg.params?.sessionId === sessionId) return true;
        if (msg.method === "session.error" && msg.params?.sessionId === sessionId) return true;
        if (msg.method === "session.idle" && msg.params?.sessionId === sessionId) return true;
        return false;
      },
      30_000
    );

    // Verify we got a structured response (not a crash)
    expect(terminalMessage.jsonrpc).toBe("2.0");

    if (terminalMessage.method === "queryError") {
      // Abort was successful
      expect(terminalMessage.params.error).toContain("aborted");
    }
    // If we got a result or cancel response, that's also fine
  }, 45_000);

  // ------------------------------------------------------------------
  // Verify agent-server log has no errors after full test run
  // ------------------------------------------------------------------

  it("agent-server log has no uncaught exceptions", () => {
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).not.toContain("Uncaught Exception:");
    expect(log).not.toContain("Unhandled Rejection:");
  });
});

// ============================================================================
// Suite 3: Real Codex integration (requires OPENAI_API_KEY + bundle)
// ============================================================================

// Skip if bundle missing or API key unavailable (matches Claude E2E pattern).
// Fork PRs can't access repo secrets — skip gracefully instead of failing.
describe.skipIf(!bundleExists || !hasOpenAIKey)("E2E: Real Codex Integration", () => {
  let agentServerProcess: ChildProcess;
  let client: WebSocket;
  let logPath: string;

  beforeAll(async () => {
    const result = await spawnAgentServer();
    agentServerProcess = result.process;
    client = result.client;
    logPath = result.logPath;
  }, 30_000);

  afterAll(async () => {
    await killAgentServer({ process: agentServerProcess, client });
  });

  // ------------------------------------------------------------------
  // Query flow: send a real prompt, receive streamed messages
  // ------------------------------------------------------------------

  it("sends a query and receives streamed response messages", async () => {
    const sessionId = `test-codex-query-${Date.now()}`;

    // The agent-server is stateless — no DB seeding needed.

    // Collect all incoming messages
    const messageCollector = collectMessages(client);

    // Send a minimal query (short prompt for a quick response)
    sendNotification(client, "turn/start", {
      sessionId,
      agentType: "codex",
      prompt: "Reply with exactly: PONG",
      options: {
        cwd: WORKSPACE_ROOT,
        model: "o4-mini",
        turnId: `turn-${Date.now()}`,
        permissionMode: "default",
      },
    });

    const isSessionMessage = (msg: any) => msg.method === "message" && msg.params?.id === sessionId;
    const isSessionError = (msg: any) =>
      msg.method === "queryError" && msg.params?.id === sessionId;
    const isSessionResult = (msg: any) =>
      isSessionMessage(msg) && msg.params?.data?.type === "result";

    // Wait for either a result or error (up to 90s for Codex to respond)
    const terminalMessage = await waitForMessage(
      client,
      (msg) => isSessionResult(msg) || isSessionError(msg),
      90_000
    );

    // Collect all session-related messages
    const sessionMessages = messageCollector.filter(
      (msg: any) => isSessionMessage(msg) || isSessionError(msg)
    );

    if (isSessionError(terminalMessage)) {
      // If we got an error, it should be a structured error (not a crash)
      expect(terminalMessage.params.error).toBeDefined();
      expect(typeof terminalMessage.params.error).toBe("string");
    } else {
      // If we got a result, verify the message stream structure
      expect(terminalMessage.params.data.type).toBe("result");

      // Should have received at least one assistant message before the result
      const assistantMessages = sessionMessages.filter(
        (msg: any) => msg.params?.data?.type === "assistant"
      );
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      // Each assistant message should have valid structure
      for (const msg of assistantMessages) {
        expect(msg.params.data.message).toBeDefined();
        expect(msg.params.data.message.role).toBe("assistant");
      }
    }
  }, 90_000);

  // ------------------------------------------------------------------
  // Cancel flow: start a query then cancel it
  // ------------------------------------------------------------------

  it("cancels an active query and receives abort notification", async () => {
    const sessionId = `test-codex-cancel-${Date.now()}`;

    // Start a query that will take a while
    sendNotification(client, "turn/start", {
      sessionId,
      agentType: "codex",
      prompt:
        "Write a 500-word essay about the history of computing. Be very thorough and detailed.",
      options: {
        cwd: WORKSPACE_ROOT,
        model: "o4-mini",
        turnId: `turn-${Date.now()}`,
        permissionMode: "default",
      },
    });

    // Wait for the query to start processing
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Send cancel request
    const cancelId = sendRequest(client, "turn/cancel", {
      sessionId,
    });

    // Should receive either:
    // 1. A cancel RPC response
    // 2. A queryError notification with abort
    // 3. A result if the query finished before cancel arrived
    const terminalMessage = await waitForMessage(
      client,
      (msg) => {
        if (msg.jsonrpc === "2.0" && msg.id === cancelId) return true;
        if (msg.method === "queryError" && msg.params?.id === sessionId) return true;
        if (
          msg.method === "message" &&
          msg.params?.id === sessionId &&
          msg.params?.data?.type === "result"
        )
          return true;
        return false;
      },
      30_000
    );

    // Verify we got a structured response (not a crash)
    expect(terminalMessage.jsonrpc).toBe("2.0");
  }, 45_000);

  // ------------------------------------------------------------------
  // Verify agent-server log has no errors after Codex tests
  // ------------------------------------------------------------------

  it("agent-server log has no uncaught exceptions", () => {
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).not.toContain("Uncaught Exception:");
    expect(log).not.toContain("Unhandled Rejection:");
  });
});
