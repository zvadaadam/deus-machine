#!/usr/bin/env node
// agent-server/cli.ts
// Debug CLI for the agent-server. Spawns the server (or connects to an
// existing one via --url), sends queries, and pretty-prints every canonical
// event for inspection. Legacy events are filtered out — only our unified
// event system is shown.
//
// Two visual layers per turn:
//   RAW    — the raw SDK message from Claude Code / Codex (message.assistant, message.tool_result)
//   PARTS  — our unified Part transformation (message.parts)
//
// Usage:
//   bunx tsx apps/agent-server/cli.ts [options] [prompt]
//
// Options:
//   --url <ws://...>   Connect to a running agent-server instead of spawning one
//   --agent <type>     Agent type: "claude" (default) or "codex"
//   --model <model>    Model to use (default: "sonnet")
//   --cwd <path>       Working directory for the agent (default: cwd)
//   --session <id>     Session ID (default: auto-generated)
//   --no-color         Disable colors
//
// If no prompt is given, enters interactive REPL mode.

import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Legacy methods to filter out (we only show canonical dot-notation events)
// ---------------------------------------------------------------------------

const LEGACY_METHODS = new Set([
  "message",
  "statusChanged",
  "queryError",
  "enterPlanModeNotification",
]);

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const useColor = !process.argv.includes("--no-color") && process.stdout.isTTY;

const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  red: useColor ? "\x1b[31m" : "",
  green: useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  blue: useColor ? "\x1b[34m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  gray: useColor ? "\x1b[90m" : "",
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  const positional: string[] = [];

  let pastSeparator = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" && !pastSeparator) {
      pastSeparator = true;
      continue;
    }
    if (arg === "--no-color") continue;
    if (!pastSeparator && arg.startsWith("--") && i + 1 < args.length) {
      opts[arg.slice(2)] = args[++i];
    } else {
      positional.push(arg);
    }
  }

  return {
    url: opts.url,
    agent: opts.agent || "claude",
    model: opts.model, // no default — each harness has its own default
    cwd: opts.cwd || process.cwd(),
    session: opts.session || `cli-${Date.now()}`,
    prompt: positional.join(" ") || null,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function ts(): string {
  const now = new Date();
  return `${c.dim}${now.toLocaleTimeString("en-US", { hour12: false })}.${String(now.getMilliseconds()).padStart(3, "0")}${c.reset}`;
}

function banner(text: string) {
  const line = "─".repeat(Math.max(0, 60 - text.length));
  console.log(`\n${c.dim}──${c.reset} ${c.bold}${text}${c.reset} ${c.dim}${line}${c.reset}`);
}

function json(obj: any, indent = 2) {
  const str = JSON.stringify(obj, null, 2);
  const pad = " ".repeat(indent);
  for (const line of str.split("\n")) {
    console.log(`${pad}${c.dim}${line}${c.reset}`);
  }
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\n/g, "\\n");
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** Deep-clone an object, truncating string values longer than `max` chars */
function truncateStrings(obj: any, max = 200): any {
  if (typeof obj === "string") {
    return obj.length > max
      ? obj.slice(0, max - 1).replace(/\n/g, "\\n") + "…"
      : obj.replace(/\n/g, "\\n");
  }
  if (Array.isArray(obj)) return obj.map((v) => truncateStrings(v, max));
  if (obj && typeof obj === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = truncateStrings(v, max);
    }
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Event classification and printing
// ---------------------------------------------------------------------------

// SDK events: these wrap raw messages from Claude Code / Codex
const SDK_EVENTS = new Set([
  "message.system",
  "message.assistant",
  "message.tool_result",
  "message.result",
]);

// Our canonical events
const DEUS_EVENTS = new Set([
  "session.started",
  "session.idle",
  "session.error",
  "session.cancelled",
  "session.title",
  "agent.session_id",
  "turn.started",
  "message.created",
  "part.created",
  "part.delta",
  "part.done",
  "message.done",
  "turn.completed",
  "message.cancelled",
  "request.opened",
  "request.resolved",
  "tool.request",
]);

function classifyEvent(method: string): { origin: string; color: string } {
  if (SDK_EVENTS.has(method)) {
    return { origin: "SDK", color: c.blue };
  }
  if (DEUS_EVENTS.has(method)) {
    return { origin: "DEUS", color: c.green };
  }
  // Unknown — show it anyway
  return { origin: "???", color: c.yellow };
}

function printEvent(method: string, params: any, agentLabel: string) {
  const { origin, color: originColor } = classifyEvent(method);

  // Color the method name by category
  let methodColor = c.cyan;
  if (method.startsWith("session.")) methodColor = c.magenta;
  if (method.startsWith("message.parts")) methodColor = c.green;
  if (method.startsWith("message.assistant") || method.startsWith("message.tool_result"))
    methodColor = c.blue;
  if (method.startsWith("message.result")) methodColor = c.yellow;
  if (method.includes("error")) methodColor = c.red;

  // Origin tag: CLAUDE/CODEX for SDK events, DEUS for ours
  const originTag = origin === "SDK" ? agentLabel : origin;

  // Header: timestamp ◂ method                                    [ORIGIN]
  const header = `${method}`;
  const pad = Math.max(1, 50 - header.length);
  console.log(
    `${ts()} ${c.green}◂${c.reset} ${methodColor}${c.bold}${header}${c.reset}${" ".repeat(pad)}${originColor}${originTag}${c.reset}`
  );

  // Strip envelope fields we already show in the header
  const { type: _t, sessionId: _s, agentType: _a, ...payload } = params;

  // Show the raw JSON payload with long strings truncated
  if (Object.keys(payload).length > 0) {
    json(truncateStrings(payload), 2);
  }
}

// ---------------------------------------------------------------------------
// Agent server lifecycle
// ---------------------------------------------------------------------------

async function spawnServer(): Promise<{ ws: WebSocket; proc: ChildProcess; logPath: string }> {
  const bundlePath = path.resolve(__dirname, "dist", "index.bundled.cjs");
  const logPath = path.resolve(__dirname, "dist", `cli-server-${Date.now()}.log`);

  console.log(`${c.dim}Spawning agent-server...${c.reset}`);
  console.log(`${c.dim}Server logs: ${logPath}${c.reset}`);

  const fs = await import("fs");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const proc = spawn("node", [bundlePath], {
    env: { ...process.env, LOG_LEVEL: "info" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr?.on("data", (data: Buffer) => {
    logStream.write(data);
  });

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 15_000);

    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const match = buffer.match(/LISTEN_URL=(.+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1].trim());
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Server exited with code ${code}`));
    });
  });

  console.log(`${c.green}Server listening:${c.reset} ${wsUrl}`);
  const ws = await connectWs(wsUrl);
  return { ws, proc, logPath };
}

async function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connection timed out"));
    }, 10_000);

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

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

let rpcId = 0;

function sendRequest(ws: WebSocket, method: string, params: any): number {
  const id = ++rpcId;
  const frame = { jsonrpc: "2.0", id, method, params };
  console.log(
    `${ts()} ${c.blue}▸${c.reset} ${c.bold}${method}${c.reset} ${c.dim}id=${id}${c.reset}`
  );
  ws.send(JSON.stringify(frame));
  return id;
}

function sendNotification(ws: WebSocket, method: string, params: any): void {
  const frame = { jsonrpc: "2.0", method, params };
  console.log(`${ts()} ${c.blue}▸${c.reset} ${c.bold}${method}${c.reset}`);
  ws.send(JSON.stringify(frame));
}

function waitForResponse(ws: WebSocket, id: number, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`RPC timeout (id=${id})`));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(msg);
        }
      } catch {
        /* ignore */
      }
    }

    ws.on("message", handler);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  const harnessLabel = opts.agent === "codex" ? "Codex" : "Claude Code";
  banner("Agent Server Debug CLI");
  console.log(`  harness: ${c.bold}${harnessLabel}${c.reset} ${c.dim}(${opts.agent})${c.reset}`);
  console.log(`  model:   ${opts.model || `${c.dim}(default)${c.reset}`}`);
  console.log(`  cwd:     ${c.dim}${opts.cwd}${c.reset}`);
  console.log(`  session: ${c.dim}${opts.session}${c.reset}`);

  let ws: WebSocket;
  let proc: ChildProcess | null = null;

  if (opts.url) {
    console.log(`\n${c.dim}Connecting to ${opts.url}...${c.reset}`);
    ws = await connectWs(opts.url);
    console.log(`${c.green}Connected${c.reset}`);
  } else {
    const result = await spawnServer();
    ws = result.ws;
    proc = result.proc;
  }

  // State
  let turnCounter = 0;
  let isRunning = false;
  let rl: readline.Interface | null = null;
  let onTurnEnd: (() => void) | null = null;

  // Listen for canonical events only
  ws.on("message", (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Skip RPC responses (handled by waitForResponse)
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) return;

      // Skip legacy notifications
      if (LEGACY_METHODS.has(msg.method)) return;

      // This is a canonical event (dot-notation method)
      const method = msg.method;
      const params = msg.params || {};

      // Derive provider label from agentType in the event
      const agentType = params.agentType || opts.agent;
      const agentLabel = agentType === "codex" ? "CODEX" : "CLAUDE";

      printEvent(method, params, agentLabel);

      // Detect turn completion from canonical events
      if (
        (method === "session.idle" || method === "session.error") &&
        params.sessionId === opts.session
      ) {
        isRunning = false;
        onTurnEnd?.();
        onTurnEnd = null;
        if (rl) {
          if (method === "session.idle") banner("Ready");
          rl.prompt();
        }
      }
    } catch {
      console.log(`${c.red}[unparseable]${c.reset} ${data.toString().slice(0, 200)}`);
    }
  });

  // Handshake
  banner("Handshake");
  const initId = sendRequest(ws, "initialize", {});
  const initResp = await waitForResponse(ws, initId);
  const agents = initResp.result?.agents?.map((a: any) => a.id || a.type || a.name).filter(Boolean);
  console.log(
    `${c.green}Initialized${c.reset} v${initResp.result?.version} agents=[${agents?.join(", ") || "?"}]`
  );

  // Send query
  async function sendQuery(prompt: string) {
    turnCounter++;
    isRunning = true;
    const turnId = `${opts.session}-turn-${turnCounter}`;

    banner(`Turn ${turnCounter}`);
    console.log(`  ${c.dim}turnId: ${turnId}${c.reset}`);
    console.log(`  ${c.dim}prompt: ${truncate(prompt, 80)}${c.reset}\n`);

    sendNotification(ws, "turn/start", {
      sessionId: opts.session,
      agentType: opts.agent,
      prompt,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        turnId,
        permissionMode: "default",
      },
    });
  }

  // Single-shot mode
  if (opts.prompt) {
    await sendQuery(opts.prompt);
    if (isRunning) {
      await new Promise<void>((resolve) => {
        onTurnEnd = resolve;
      });
    }
    ws.close();
    proc?.kill("SIGTERM");
    return;
  }

  // Interactive REPL
  banner("Interactive Mode");
  console.log(`  Type a prompt and press Enter.`);
  console.log(
    `  ${c.bold}.help${c.reset} for commands, ${c.bold}Ctrl+C${c.reset} to cancel turn, double ${c.bold}Ctrl+C${c.reset} to quit.\n`
  );

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.cyan}>${c.reset} `,
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl!.prompt();
      return;
    }

    if (input === ".exit" || input === ".quit") {
      ws.close();
      proc?.kill("SIGTERM");
      process.exit(0);
    }
    if (input === ".help") {
      console.log(`  ${c.bold}.exit${c.reset}          Quit`);
      console.log(`  ${c.bold}.session <id>${c.reset}  Switch session`);
      console.log(`  ${c.bold}.model <name>${c.reset}  Switch model`);
      console.log(`  ${c.bold}.agent <type>${c.reset}  Switch agent (claude/codex)`);
      console.log(`  ${c.bold}.cancel${c.reset}        Cancel running turn`);
      rl!.prompt();
      return;
    }
    if (input.startsWith(".session ")) {
      opts.session = input.slice(9).trim();
      console.log(`${c.green}Session:${c.reset} ${opts.session}`);
      rl!.prompt();
      return;
    }
    if (input.startsWith(".model ")) {
      opts.model = input.slice(7).trim();
      console.log(`${c.green}Model:${c.reset} ${opts.model}`);
      rl!.prompt();
      return;
    }
    if (input.startsWith(".agent ")) {
      opts.agent = input.slice(7).trim();
      console.log(`${c.green}Agent:${c.reset} ${opts.agent}`);
      rl!.prompt();
      return;
    }
    if (input === ".cancel") {
      if (isRunning) sendNotification(ws, "turn/cancel", { sessionId: opts.session });
      else console.log(`${c.dim}No turn running${c.reset}`);
      rl!.prompt();
      return;
    }

    await sendQuery(input);
  });

  let cancelSentAt = 0;
  rl.on("SIGINT", () => {
    const now = Date.now();
    if (isRunning && now - cancelSentAt > 1000) {
      cancelSentAt = now;
      console.log(`\n${c.yellow}Cancelling turn… (Ctrl+C again to quit)${c.reset}`);
      sendNotification(ws, "turn/cancel", { sessionId: opts.session });
    } else {
      console.log(`\n${c.dim}Bye${c.reset}`);
      ws.close();
      proc?.kill("SIGTERM");
      process.exit(0);
    }
  });

  rl.on("close", () => {
    ws.close();
    proc?.kill("SIGTERM");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
