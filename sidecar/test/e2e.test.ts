import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess, execSync } from "child_process";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";

/**
 * End-to-end tests: Spawn a real sidecar process, connect via
 * Unix domain socket, send JSON-RPC messages, verify responses.
 *
 * Two test suites:
 * 1. Protocol compliance — tests JSON-RPC protocol handling (always runs)
 * 2. Real Claude integration — tests actual Claude SDK calls against a
 *    real repository with a real Claude CLI (skipped if CLI unavailable)
 *
 * NOTE: These tests require:
 * 1. The sidecar bundle to be built: `npx tsx sidecar/build.ts`
 * 2. Claude CLI to be installed (for integration tests)
 */

const SIDECAR_DIR = path.resolve(__dirname, "..");
const BUNDLE_PATH = path.resolve(
  SIDECAR_DIR,
  "..",
  "src-tauri",
  "resources",
  "bin",
  "index.bundled.cjs"
);

// The workspace root — a real git repo for integration tests
const WORKSPACE_ROOT = path.resolve(SIDECAR_DIR, "..");

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

// ============================================================================
// Helpers
// ============================================================================

/** Wait for a message matching a predicate from the socket */
function waitForMessage(
  socket: net.Socket,
  predicate: (msg: any) => boolean,
  timeoutMs = 10000
): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const timer = setTimeout(() => {
      socket.removeListener("data", onData);
      reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function onData(data: Buffer) {
      buffer += decoder.write(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (predicate(msg)) {
            clearTimeout(timer);
            socket.removeListener("data", onData);
            resolve(msg);
            return;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    socket.on("data", onData);
  });
}

/** Collect all messages from a socket into an array (non-blocking) */
function collectMessages(socket: net.Socket): any[] {
  const messages: any[] = [];
  let buffer = "";
  const decoder = new StringDecoder("utf8");

  socket.on("data", (data) => {
    buffer += decoder.write(data);
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Ignore parse errors
      }
    }
  });

  return messages;
}

/** Send a JSON-RPC notification (fire-and-forget) */
function sendNotification(socket: net.Socket, method: string, params: any): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  socket.write(msg + "\n");
}

/** Send a JSON-RPC request and return its ID */
let rpcIdCounter = 1;
function sendRequest(socket: net.Socket, method: string, params: any): number {
  const id = rpcIdCounter++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  socket.write(msg + "\n");
  return id;
}

/** Spawn a sidecar process and connect a client socket */
async function spawnSidecar(): Promise<{
  process: ChildProcess;
  socketPath: string;
  client: net.Socket;
  logPath: string;
}> {
  const proc = spawn("node", [BUNDLE_PATH], {
    env: {
      ...process.env,
      LOG_LEVEL: "debug",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrOutput = "";
  proc.stderr?.on("data", (data) => {
    stderrOutput += data.toString();
  });

  // Wait for SOCKET_PATH= from stdout
  const socketPath = await new Promise<string>((resolve, reject) => {
    let stdoutBuffer = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Sidecar did not print SOCKET_PATH within 15s. stderr: ${stderrOutput}`));
    }, 15_000);

    proc.stdout?.on("data", (data) => {
      stdoutBuffer += data.toString();
      const match = stdoutBuffer.match(/SOCKET_PATH=(.+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1].trim());
      }
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Sidecar exited with code ${code}. stderr: ${stderrOutput}`));
    });
  });

  // Connect to the sidecar's Unix domain socket
  const client = await new Promise<net.Socket>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Client connection timed out")), 5000);
    const sock = net.connect(socketPath, () => {
      clearTimeout(timeout);
      resolve(sock);
    });
    sock.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const logPath = `/tmp/hive-${proc.pid}.log`;

  return { process: proc, socketPath, client, logPath };
}

/** Kill a sidecar process and clean up */
async function killSidecar(sidecar: {
  process: ChildProcess;
  socketPath: string;
  client: net.Socket;
}): Promise<void> {
  if (sidecar.client) {
    sidecar.client.destroy();
  }
  if (sidecar.process) {
    sidecar.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      sidecar.process.on("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
  }
  if (sidecar.socketPath && fs.existsSync(sidecar.socketPath)) {
    try {
      fs.unlinkSync(sidecar.socketPath);
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// Suite 1: Protocol compliance (no Claude CLI required)
// ============================================================================

describe.skipIf(!bundleExists)("E2E: Sidecar Process", () => {
  let sidecarProcess: ChildProcess;
  let socketPath: string;
  let client: net.Socket;

  beforeAll(async () => {
    const sidecar = await spawnSidecar();
    sidecarProcess = sidecar.process;
    socketPath = sidecar.socketPath;
    client = sidecar.client;
  }, 30_000);

  afterAll(async () => {
    await killSidecar({ process: sidecarProcess, socketPath, client });
  });

  it("connects to the sidecar's Unix socket", () => {
    expect(client).toBeDefined();
    expect(socketPath).toBeDefined();
    expect(socketPath).toContain("hive-sidecar-");
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
    const id = sendRequest(client, "claudeAuth", {
      type: "claude_auth",
      id: "test-session",
      agentType: "claude",
      options: { cwd: "/tmp" },
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
    client.write("this is not valid json\n");
    client.write("{ incomplete\n");

    const id = sendRequest(client, "claudeAuth", {
      type: "claude_auth",
      id: "test-after-garbage",
      agentType: "claude",
      options: { cwd: "/tmp" },
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
    client.write(JSON.stringify({ foo: "bar", not: "jsonrpc" }) + "\n");

    const id = sendRequest(client, "claudeAuth", {
      type: "claude_auth",
      id: "test-after-nonjsonrpc",
      agentType: "claude",
      options: { cwd: "/tmp" },
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
  let sidecarProcess: ChildProcess;
  let socketPath: string;
  let client: net.Socket;
  let logPath: string;

  beforeAll(async () => {
    const sidecar = await spawnSidecar();
    sidecarProcess = sidecar.process;
    socketPath = sidecar.socketPath;
    client = sidecar.client;
    logPath = sidecar.logPath;
  }, 30_000);

  afterAll(async () => {
    await killSidecar({ process: sidecarProcess, socketPath, client });
  });

  // ------------------------------------------------------------------
  // Claude CLI discovery
  // ------------------------------------------------------------------

  it("discovers Claude CLI during initialization", () => {
    // The sidecar log records whether initialization succeeded
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("Claude executable initialized with version:");
    expect(log).toContain("handler initialized successfully");
    // Must NOT contain the initialization failure message
    expect(log).not.toContain("initialization failed");
  });

  // ------------------------------------------------------------------
  // Authentication check (real Claude SDK call)
  // ------------------------------------------------------------------

  it("returns real account info via claudeAuth", async () => {
    const id = sendRequest(client, "claudeAuth", {
      type: "claude_auth",
      id: "test-auth-real",
      agentType: "claude",
      options: { cwd: WORKSPACE_ROOT },
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
    const id = sendRequest(client, "workspaceInit", {
      type: "workspace_init",
      id: "test-workspace-init",
      agentType: "claude",
      options: { cwd: WORKSPACE_ROOT },
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
    const receivedMessages: any[] = [];

    // Set up a collector for all incoming messages
    const messageCollector = collectMessages(client);

    // Send a minimal query (short prompt to get a quick response)
    sendNotification(client, "query", {
      type: "query",
      id: sessionId,
      agentType: "claude",
      prompt: "Reply with exactly: PONG",
      options: {
        cwd: WORKSPACE_ROOT,
        model: "sonnet",
        turnId: `turn-${Date.now()}`,
        permissionMode: "default",
      },
    });

    // Wait for a "result" notification (query completion) or an error
    // The sidecar sends messages as JSON-RPC notifications with method "message"
    // Messages arrive as: { jsonrpc: "2.0", method: "message", params: { id, type, data } }
    const isSessionMessage = (msg: any) => msg.method === "message" && msg.params?.id === sessionId;

    const isSessionError = (msg: any) =>
      msg.method === "queryError" && msg.params?.id === sessionId;

    const isSessionResult = (msg: any) =>
      isSessionMessage(msg) && msg.params?.data?.type === "result";

    // Wait for either a result or error (up to 60s for Claude to respond)
    const terminalMessage = await waitForMessage(
      client,
      (msg) => isSessionResult(msg) || isSessionError(msg),
      60_000
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
    const sessionId = `test-cancel-${Date.now()}`;

    // Start a query that will take a while (ask for a long response)
    sendNotification(client, "query", {
      type: "query",
      id: sessionId,
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
    const cancelId = sendRequest(client, "cancel", {
      type: "cancel",
      id: sessionId,
      agentType: "claude",
    });

    // Should receive either:
    // 1. A cancel RPC response (method result)
    // 2. A queryError notification with "aborted by user"
    // 3. A result if the query finished before cancel arrived
    const terminalMessage = await waitForMessage(
      client,
      (msg) => {
        // Cancel RPC response
        if (msg.jsonrpc === "2.0" && msg.id === cancelId) return true;
        // Error notification for this session
        if (msg.method === "queryError" && msg.params?.id === sessionId) return true;
        // Query result (completed before cancel)
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

    if (terminalMessage.method === "queryError") {
      // Abort was successful
      expect(terminalMessage.params.error).toContain("aborted");
    }
    // If we got a result or cancel response, that's also fine
  }, 45_000);

  // ------------------------------------------------------------------
  // Verify sidecar log has no errors after full test run
  // ------------------------------------------------------------------

  it("sidecar log has no uncaught exceptions", () => {
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).not.toContain("Uncaught Exception:");
    expect(log).not.toContain("Unhandled Rejection:");
  });
});
