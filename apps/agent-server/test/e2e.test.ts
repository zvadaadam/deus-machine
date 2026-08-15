import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";
import { AgentServerClient } from "@zvada/agent-server/client";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";
import { WIRE_PROTOCOL_VERSION } from "@zvada/agent-server/protocol";
import {
  SIDE_CHANNEL,
  SideChannelEndpoint,
  claimSideChannel,
  wsLineTransport,
} from "@shared/agent-side-channel";
import { resolveBundledCliPath } from "@shared/lib/cli-path";

/**
 * End-to-end tests: Spawn the real agent-server bundle, connect over the
 * standard @zvada/agent-server wire (typed client), verify turns + the deus
 * side channel.
 *
 * Three test suites:
 * 1. Protocol compliance — wire-level handling (always runs when built)
 * 2. Real Claude integration — actual Claude turns (opt-in)
 * 3. Real Codex integration — actual Codex turns (opt-in, needs API key)
 *
 * NOTE: These tests require:
 * 1. The agent-server bundle to be built: `bun run build:agent-server`
 * 2. DEUS_AGENT_SERVER_E2E_REAL_CLAUDE=1 (for Claude integration tests)
 * 3. DEUS_AGENT_SERVER_E2E_REAL_CODEX=1 and OPENAI_API_KEY env var (for Codex)
 */

const AGENT_SERVER_DIR = path.resolve(__dirname, "..");
const BUNDLE_PATH = path.resolve(AGENT_SERVER_DIR, "dist", "index.bundled.cjs");

// The workspace root — a real git repo for integration tests
const WORKSPACE_ROOT = path.resolve(AGENT_SERVER_DIR, "..");

const bundleExists = fs.existsSync(BUNDLE_PATH);

const runRealClaudeIntegration = process.env.DEUS_AGENT_SERVER_E2E_REAL_CLAUDE === "1";
const runRealCodexIntegration = process.env.DEUS_AGENT_SERVER_E2E_REAL_CODEX === "1";

const claudePath = process.env.CLAUDE_CLI_PATH || resolveBundledCliPath("claude");
const claudeCliAvailable =
  runRealClaudeIntegration && !!(claudePath && isExecutableFile(claudePath));

const hasOpenAIKey = !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
const codexIntegrationEnabled = runRealCodexIntegration && hasOpenAIKey;

const isCI = !!process.env.CI;

function isExecutableFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  if (process.platform === "win32") return true;
  return (fs.statSync(filePath).mode & 0o111) !== 0;
}

// ============================================================================
// CI prerequisite guard — fail fast with clear messages
// ============================================================================

if (isCI) {
  describe("CI: Required E2E prerequisites", () => {
    it("agent-server bundle exists", () => {
      expect(bundleExists, "Run 'bun run build:agent-server' before E2E tests").toBe(true);
    });

    it("OPENAI_API_KEY is set when real Codex E2E is enabled", () => {
      if (!runRealCodexIntegration) return;
      expect(hasOpenAIKey, "Add OPENAI_API_KEY as a GitHub Actions secret").toBe(true);
    });
  });
}

// ============================================================================
// Helpers
// ============================================================================

interface SpawnedServer {
  process: ChildProcess;
  wsUrl: string;
  logPath: string;
}

/** Spawn the agent-server bundle and wait for its LISTEN_URL. */
async function spawnAgentServer(): Promise<SpawnedServer> {
  const proc = spawn("node", [BUNDLE_PATH], {
    env: { ...process.env, LOG_LEVEL: "debug" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrOutput = "";
  proc.stderr?.on("data", (data: Buffer) => {
    stderrOutput += data.toString();
  });

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let stdoutBuffer = "";
    const timeout = setTimeout(() => {
      reject(
        new Error(`Agent-server did not print LISTEN_URL within 30s. stderr: ${stderrOutput}`)
      );
    }, 30_000);

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

  return { process: proc, wsUrl, logPath: `/tmp/deus-${proc.pid}.log` };
}

async function killAgentServer(srv: SpawnedServer): Promise<void> {
  srv.process.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    srv.process.on("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
}

/** Open a raw WebSocket (for wire-level protocol assertions). */
function openRawSocket(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
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
}

/** Wait for a message matching a predicate on a raw socket. */
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

interface BackendStyleConnection {
  client: AgentServerClient;
  sideChannel: SideChannelEndpoint;
  envelopes: DecodedWireEventEnvelope[];
  close(): Promise<void>;
}

/** Connect the way the backend does: typed client + deus side channel. */
async function connectBackendStyle(
  wsUrl: string,
  onToolRequest?: (method: string, params: unknown) => Promise<unknown>
): Promise<BackendStyleConnection> {
  const ws = await openRawSocket(wsUrl);
  const transport = wsLineTransport(ws);

  const sideChannel = new SideChannelEndpoint((line) => transport.send(line), "e2e-backend");
  if (onToolRequest) {
    for (const method of Object.values(SIDE_CHANNEL)) {
      sideChannel.onRequest(method, (params) => onToolRequest(method, params));
    }
  }
  sideChannel.notify(SIDE_CHANNEL.hello, {});

  const client = await AgentServerClient.attach(claimSideChannel(transport, sideChannel));
  const envelopes: DecodedWireEventEnvelope[] = [];
  client.onEvent((envelope) => envelopes.push(envelope));

  return {
    client,
    sideChannel,
    envelopes,
    close: async () => {
      await client.close();
      ws.close();
    },
  };
}

// ============================================================================
// Suite 1: Protocol compliance (no Claude CLI required)
// ============================================================================

describe.skipIf(!bundleExists)("E2E: Agent Server Process", () => {
  let srv: SpawnedServer;

  beforeAll(async () => {
    srv = await spawnAgentServer();
  }, 40_000);

  afterAll(async () => {
    await killAgentServer(srv);
  });

  it("handshakes on the standard wire (current protocol version, three harnesses)", async () => {
    const conn = await connectBackendStyle(srv.wsUrl);
    const init = await conn.client.initialize();
    expect(init.protocolVersion).toBe(WIRE_PROTOCOL_VERSION);
    expect(init.server.name).toBe("deus-agent-server");
    expect(Object.keys(init.harnesses).sort()).toEqual([
      "claude-code",
      "codex-app-server",
      "codex-sdk",
    ]);
    await conn.close();
  });

  it("answers unknown JSON-RPC methods with methodNotFound", async () => {
    const ws = await openRawSocket(srv.wsUrl);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "bogus/method", params: {} }));
    const response = await waitForMessage(ws, (msg) => msg.id === 99);
    expect(response.error?.code).toBe(-32601);
    ws.close();
  });

  it("handles malformed JSON gracefully (no crash)", async () => {
    const ws = await openRawSocket(srv.wsUrl);
    ws.send("this is not json{{{");
    const response = await waitForMessage(ws, (msg) => msg.id === null && msg.error);
    expect(response.error.code).toBe(-32700);
    // Server is still alive and answering.
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "bogus/method" }));
    const alive = await waitForMessage(ws, (msg) => msg.id === 100);
    expect(alive.error?.code).toBe(-32601);
    ws.close();
  });

  it("tolerates non-request frames (no crash, no response)", async () => {
    const ws = await openRawSocket(srv.wsUrl);
    ws.send(JSON.stringify({ hello: true }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "some/notification", params: {} }));
    // Still answering afterwards.
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 101, method: "bogus/method" }));
    const alive = await waitForMessage(ws, (msg) => msg.id === 101);
    expect(alive.error?.code).toBe(-32601);
    ws.close();
  });

  it("answers deus/provider-auth on the side channel (codex → unsupported)", async () => {
    const conn = await connectBackendStyle(srv.wsUrl);
    const result = await conn.sideChannel.request<{ error?: string }>(
      SIDE_CHANNEL.providerAuth,
      { agentHarness: "codex-sdk", cwd: WORKSPACE_ROOT },
      10_000
    );
    expect(result).toMatchObject({ error: "unsupported" });
    await conn.close();
  });
});

// ============================================================================
// Suite 2: Real Claude integration (opt-in)
// ============================================================================

describe.skipIf(!bundleExists || !claudeCliAvailable)("E2E: Real Claude Integration", () => {
  let srv: SpawnedServer;
  let conn: BackendStyleConnection;

  beforeAll(async () => {
    srv = await spawnAgentServer();
    conn = await connectBackendStyle(srv.wsUrl, async (method) => {
      // Approve everything user-facing so live turns never park.
      if (method === SIDE_CHANNEL.exitPlanMode) return { approved: true };
      throw new Error(`e2e host does not implement ${method}`);
    });
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await killAgentServer(srv);
  });

  it("returns real account info via the provider-auth side channel", async () => {
    const result = await conn.sideChannel.request<{
      accountInfo?: unknown;
      error?: string;
    }>(SIDE_CHANNEL.providerAuth, { agentHarness: "claude", cwd: WORKSPACE_ROOT }, 30_000);
    expect(result).toHaveProperty("accountInfo");
    expect((result as { error?: string }).error).toBeUndefined();
  }, 30_000);

  it("runs a real turn and streams the full lifecycle", async () => {
    const turn = await conn.client.runTurn({
      sessionId: "e2e-claude-1",
      input: 'Reply with exactly the text "E2E_OK" and nothing else.',
      config: {
        harness: "claude-code",
        cwd: WORKSPACE_ROOT,
        permissionMode: "default",
        maxTurns: 3,
      },
    });
    const ended = await turn.result;
    expect(ended.stopReason).toBe("end_turn");

    const types = conn.envelopes
      .filter((e) => e.sessionId === "e2e-claude-1")
      .map((e) => e.event.type);
    expect(types).toContain("session.created");
    expect(types).toContain("message.started");
    expect(types).toContain("turn.ended");

    const created = conn.envelopes.find(
      (e) => e.sessionId === "e2e-claude-1" && e.event.type === "session.created"
    );
    expect((created?.event as { nativeSessionId?: string }).nativeSessionId).toBeTruthy();

    const text = conn.envelopes
      .filter((e) => e.sessionId === "e2e-claude-1" && e.event.type === "message.part")
      .map((e) => {
        const part = (e.event as { part?: { type?: string; text?: string } }).part;
        return part?.type === "text" ? (part.text ?? "") : "";
      })
      .join("");
    expect(text).toContain("E2E_OK");
  }, 120_000);

  it("cancels an active turn and reports stopReason=cancelled", async () => {
    await conn.client.startTurn({
      sessionId: "e2e-claude-cancel",
      turnId: "cancel-turn",
      input: "Count slowly from 1 to 1000, one number per line.",
      config: { harness: "claude-code", cwd: WORKSPACE_ROOT, permissionMode: "default" },
    });
    // Give the turn a moment to actually start before cancelling.
    await new Promise((r) => setTimeout(r, 3_000));
    const cancel = await conn.client.cancelTurn("e2e-claude-cancel");
    // 0.3 reports one outcome: `cancelled` (harness confirmed) or
    // `unconfirmed` (dispatched best-effort). Either means the interrupt went
    // out; turn.ended below is the real assertion.
    expect(["cancelled", "unconfirmed"]).toContain(cancel.outcome);

    // The turn.ended for this session must arrive with cancelled.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no turn.ended after cancel")), 30_000);
      const off = conn.client.onEvent((envelope) => {
        if (envelope.sessionId === "e2e-claude-cancel" && envelope.event.type === "turn.ended") {
          clearTimeout(timer);
          off();
          expect((envelope.event as { stopReason?: string }).stopReason).toBe("cancelled");
          resolve();
        }
      });
      // Check the backlog too (it may have landed before this listener).
      const existing = conn.envelopes.find(
        (e) => e.sessionId === "e2e-claude-cancel" && e.event.type === "turn.ended"
      );
      if (existing) {
        clearTimeout(timer);
        off();
        expect((existing.event as { stopReason?: string }).stopReason).toBe("cancelled");
        resolve();
      }
    });
  }, 90_000);

  it("agent-server log has no uncaught exceptions", () => {
    if (!fs.existsSync(srv.logPath)) return;
    const log = fs.readFileSync(srv.logPath, "utf-8");
    expect(log).not.toContain("Uncaught Exception");
  });
});

// ============================================================================
// Suite 3: Real Codex integration (opt-in)
// ============================================================================

describe.skipIf(!bundleExists || !codexIntegrationEnabled)("E2E: Real Codex Integration", () => {
  let srv: SpawnedServer;
  let conn: BackendStyleConnection;

  beforeAll(async () => {
    srv = await spawnAgentServer();
    conn = await connectBackendStyle(srv.wsUrl);
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await killAgentServer(srv);
  });

  it("runs a real codex turn and streams the full lifecycle", async () => {
    const turn = await conn.client.runTurn({
      sessionId: "e2e-codex-1",
      input: 'Reply with exactly the text "E2E_OK" and nothing else.',
      config: { harness: "codex-sdk", cwd: WORKSPACE_ROOT },
    });
    const ended = await turn.result;
    expect(ended.stopReason).toBe("end_turn");

    const types = conn.envelopes
      .filter((e) => e.sessionId === "e2e-codex-1")
      .map((e) => e.event.type);
    expect(types).toContain("session.created");
    expect(types).toContain("turn.ended");
  }, 120_000);

  it("cancels an active codex turn", async () => {
    await conn.client.startTurn({
      sessionId: "e2e-codex-cancel",
      turnId: "cancel-turn",
      input: "Count slowly from 1 to 1000, one number per line.",
      config: { harness: "codex-sdk", cwd: WORKSPACE_ROOT },
    });
    await new Promise((r) => setTimeout(r, 3_000));
    await conn.client.cancelTurn("e2e-codex-cancel");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no turn.ended after cancel")), 30_000);
      const check = (envelope: DecodedWireEventEnvelope) => {
        if (envelope.sessionId === "e2e-codex-cancel" && envelope.event.type === "turn.ended") {
          clearTimeout(timer);
          off();
          resolve();
        }
      };
      const off = conn.client.onEvent(check);
      const existing = conn.envelopes.find(
        (e) => e.sessionId === "e2e-codex-cancel" && e.event.type === "turn.ended"
      );
      if (existing) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  }, 90_000);

  it("agent-server log has no uncaught exceptions", () => {
    if (!fs.existsSync(srv.logPath)) return;
    const log = fs.readFileSync(srv.logPath, "utf-8");
    expect(log).not.toContain("Uncaught Exception");
  });
});
