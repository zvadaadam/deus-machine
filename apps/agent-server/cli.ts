#!/usr/bin/env bun
// agent-server/cli.ts
// Headless test harness for the agent-server on the standard
// @zvada/agent-server wire — no backend, no frontend.
//
// Connects exactly the way the backend does (typed AgentServerClient + the
// deus/* side channel, announcing itself as host via deus/hello), so live
// turns exercise the REAL production path: engine, tool policy, in-process
// deus MCP suite, checkpoints, seq+replay.
//
// Usage:
//   bun apps/agent-server/cli.ts                        # spawn bundle + REPL
//   bun apps/agent-server/cli.ts --url ws://127.0.0.1:PORT   # dial a running server (observer)
//   bun apps/agent-server/cli.ts --prompt "2+2?"        # one-shot turn, exit code = result
//   flags: --agent claude|codex-sdk|codex-server  --model NAME  --cwd PATH
//          --session ID  --resume NATIVE_ID  --permission-mode MODE  --json
//          --host  (claim deus tool routing when dialing with --url; a spawned
//                   server is always hosted by the CLI)
//
// Side-channel host behavior, active when this CLI is the host (so live
// turns never park). Dialing a backend-managed server with --url stays
// observer-only — announcing deus/hello there would steal tool routing from
// the real backend and leave it stolen after the CLI exits:
//   exitPlanMode    → auto-approve (logged)
//   askUserQuestion → answers each question with its first option (logged)
//   everything else → error result (tool surfaces "unavailable in CLI")

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { AgentServerClient } from "@zvada/agent-server/client";
import type { AgentHarness, TurnStartParams } from "@zvada/agent-server/protocol";
import {
  isUnknownLifecycleEvent,
  isUnknownPart,
  type AnyLifecycleEvent,
} from "@shared/protocol-types";
import { AGENT_HARNESSES, generateUUIDv7, isAgentHarness } from "@zvada/agent-server/protocol";
import {
  SIDE_CHANNEL,
  SideChannelEndpoint,
  claimSideChannel,
  wsLineTransport,
} from "@shared/agent-side-channel";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.argv.includes("--json");
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
};

const truncate = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--host") continue;
    if (arg.startsWith("--") && i + 1 < args.length) opts[arg.slice(2)] = args[++i];
  }
  const agent = (opts.agent ?? "claude-code") as AgentHarness;
  if (!isAgentHarness(agent)) {
    console.error(`Unknown --agent "${agent}" (use ${AGENT_HARNESSES.join(" | ")})`);
    process.exit(1);
  }
  return {
    url: opts.url,
    agent,
    model: opts.model,
    cwd: path.resolve(opts.cwd ?? process.cwd()),
    sessionId: opts.session ?? generateUUIDv7(),
    resume: opts.resume,
    permissionMode: opts["permission-mode"] ?? "default",
    prompt: opts.prompt,
    json: process.argv.includes("--json"),
    forceHost: process.argv.includes("--host"),
  };
}

// ---------------------------------------------------------------------------
// Event rendering
// ---------------------------------------------------------------------------

/** Part ids whose text already streamed as deltas (don't reprint on snapshot). */
const streamedParts = new Set<string>();
/** True while streamed text has no trailing newline yet. */
let midStream = false;

function breakLine(): void {
  if (midStream) {
    process.stdout.write("\n");
    midStream = false;
  }
}

function renderEvent(event: AnyLifecycleEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(event));
    return;
  }
  if (isUnknownLifecycleEvent(event)) {
    // Law 6: a type this build does not know still gets a line — silence is
    // how a newer server's events become invisible.
    breakLine();
    console.log(`${c.dim}◆ ${event.type} (unknown to this build)${c.reset}`);
    return;
  }
  if (event.type !== "message.part.delta" && event.type !== "message.part") breakLine();
  switch (event.type) {
    case "session.created":
      console.log(
        `${c.dim}◆ session.created${c.reset} native=${event.nativeSessionId}` +
          (event.resumed !== undefined ? ` resumed=${event.resumed}` : "")
      );
      return;
    case "turn.started":
      console.log(`${c.dim}◆ turn.started ${event.turnId}${c.reset}`);
      return;
    case "message.started":
      console.log(`${c.dim}◆ message ${event.messageId} (${event.role})${c.reset}`);
      return;
    case "message.part.delta":
      streamedParts.add(event.partId);
      if (event.delta.type === "text") {
        process.stdout.write(event.delta.text);
        midStream = true;
      } else if (event.delta.type === "reasoning") {
        process.stdout.write(`${c.dim}${event.delta.text}${c.reset}`);
        midStream = true;
      }
      return;
    case "message.part": {
      const part = event.part;
      // Law 6: an unknown part type has no fields to render, only a name.
      if (isUnknownPart(part)) {
        breakLine();
        console.log(`${c.dim}▸ ${part.type} part (unknown to this build)${c.reset}`);
        return;
      }
      // Short outputs can arrive as one finished part with no delta stream.
      if (part.type === "text" && part.state === "done" && !streamedParts.has(part.id)) {
        streamedParts.add(part.id);
        process.stdout.write(part.text);
        midStream = true;
      }
      if (part.type === "tool") {
        breakLine();
        const status = part.state.status;
        const color = status === "completed" ? c.green : status === "failed" ? c.red : c.yellow;
        console.log(
          `${color}▸ ${part.toolName}${c.reset} ${c.dim}${status}${c.reset}` +
            (part.state.status === "completed"
              ? ` ${c.dim}${truncate(part.state.output, 120)}${c.reset}`
              : part.state.status === "failed"
                ? ` ${c.red}${truncate(part.state.error, 120)}${c.reset}`
                : "")
        );
      }
      return;
    }
    case "message.ended":
      breakLine();
      return;
    case "session.usage":
      console.log(
        `${c.dim}◆ usage used=${event.used}${event.size ? `/${event.size}` : ""}${event.cost !== undefined ? ` $${event.cost.toFixed(4)}` : ""}${c.reset}`
      );
      return;
    case "session.compaction":
      console.log(`${c.magenta}◆ context compacted (${event.status})${c.reset}`);
      return;
    case "turn.ended": {
      const color = event.stopReason === "end_turn" ? c.green : c.red;
      const tokens = event.tokens ? ` in=${event.tokens.input} out=${event.tokens.output}` : "";
      const cost = event.cost !== undefined ? ` $${event.cost.toFixed(4)}` : "";
      console.log(
        `${color}◆ turn.ended ${event.stopReason}${c.reset}${c.dim}${tokens}${cost}${c.reset}`
      );
      return;
    }
    case "error":
      console.log(
        `${event.recoverable ? c.yellow : c.red}◆ error${event.recoverable ? " (recoverable)" : ""}: ${event.message}${c.reset}`
      );
      return;
    case "permission.requested":
      console.log(`${c.yellow}◆ permission.requested ${event.title}${c.reset}`);
      return;
    default:
      console.log(`${c.dim}◆ ${event.type}${c.reset}`);
  }
}

// ---------------------------------------------------------------------------
// Server spawn / connect
// ---------------------------------------------------------------------------

async function resolveServerUrl(opts: {
  url?: string;
}): Promise<{ url: string; proc: ChildProcess | null }> {
  if (opts.url) return { url: opts.url, proc: null };

  const bundlePath = path.resolve(__dirname, "dist", "index.bundled.cjs");
  if (!fs.existsSync(bundlePath)) {
    console.error(`${c.red}Bundle missing. Run: bun run build:agent-server${c.reset}`);
    process.exit(1);
  }
  const proc = spawn("node", [bundlePath], {
    env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "info" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => reject(new Error(`agent-server did not print LISTEN_URL in 30s\n${stderr}`)),
      30_000
    );
    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const match = buffer.match(/LISTEN_URL=(.+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1].trim());
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`agent-server exited (${code}) before listening\n${stderr}`));
    });
  });
  return { url, proc };
}

interface Connection {
  client: AgentServerClient;
  close(): void;
}

async function connect(url: string, json: boolean, announceHost: boolean): Promise<Connection> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const transport = wsLineTransport(ws);

  const sideChannel = new SideChannelEndpoint((line) => transport.send(line), "cli");
  sideChannel.onRequest(SIDE_CHANNEL.exitPlanMode, () => {
    console.log(`\n${c.yellow}◆ exitPlanMode → auto-approved by CLI${c.reset}`);
    return { approved: true };
  });
  sideChannel.onRequest(SIDE_CHANNEL.askUserQuestion, (params) => {
    const { questions = [] } = (params ?? {}) as {
      questions?: Array<{ question: string; options: string[] }>;
    };
    const answers = questions.map((q) => q.options[0] ?? "");
    console.log(
      `\n${c.yellow}◆ askUserQuestion → answered with first option(s): ${JSON.stringify(answers)}${c.reset}`
    );
    return { answers };
  });
  sideChannel.onNotification(SIDE_CHANNEL.title, (params) => {
    const { title } = (params ?? {}) as { title?: string };
    console.log(`${c.dim}◆ session title: "${title}"${c.reset}`);
  });
  for (const method of [
    SIDE_CHANNEL.getDiff,
    SIDE_CHANNEL.diffComment,
    SIDE_CHANNEL.getTerminalOutput,
    SIDE_CHANNEL.getSimulatorContext,
    SIDE_CHANNEL.aapListApps,
    SIDE_CHANNEL.aapLaunchApp,
    SIDE_CHANNEL.aapStopApp,
    SIDE_CHANNEL.aapReadAppSkill,
  ]) {
    sideChannel.onRequest(method, () => {
      throw new Error(`${method} is not available in the CLI harness`);
    });
  }
  if (announceHost) {
    sideChannel.notify(SIDE_CHANNEL.hello, {});
  } else {
    console.log(
      `${c.dim}observer mode: not claiming deus tool routing (pass --host to claim)${c.reset}`
    );
  }

  const client = await AgentServerClient.attach(claimSideChannel(transport, sideChannel));
  const init = await client.initialize();
  console.log(
    `${c.green}Connected${c.reset} ${c.dim}${url} · ${init.server.name} · harnesses: ${Object.keys(init.harnesses).join(", ")}${c.reset}`
  );
  client.onEvent((envelope) => renderEvent(envelope.event, json));

  return {
    client,
    close: () => {
      void client.close();
      ws.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Turn driving
// ---------------------------------------------------------------------------

interface CliState {
  sessionId: string;
  agent: AgentHarness;
  model?: string;
  cwd: string;
  resume?: string;
  permissionMode: string;
  nativeSessionId?: string;
}

async function runTurn(conn: Connection, state: CliState, prompt: string): Promise<boolean> {
  const params: TurnStartParams = {
    sessionId: state.sessionId,
    turnId: generateUUIDv7(),
    input: prompt,
    config: {
      harness: state.agent,
      cwd: state.cwd,
      model: state.model,
      permissionMode: state.permissionMode as TurnStartParams["config"]["permissionMode"],
      resumeSessionId: state.resume,
      maxTurns: 1000,
    },
  };
  const off = conn.client.onEvent((envelope) => {
    if (envelope.sessionId !== state.sessionId) return;
    const event = envelope.event;
    if (isUnknownLifecycleEvent(event) || event.type !== "session.created") return;
    state.nativeSessionId = event.nativeSessionId;
    // Follow-up turns resume the warm conversation automatically.
    state.resume = event.nativeSessionId;
  });
  try {
    const handle = await conn.client.runTurn(params);
    const ended = await handle.result;
    return ended.stopReason === "end_turn";
  } finally {
    off();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const { url, proc } = await resolveServerUrl(opts);
  // A spawned server is private to this CLI — host it. A dialed server
  // (--url) already has a host (the backend); only claim it on --host.
  const conn = await connect(url, opts.json, proc !== null || opts.forceHost);

  const state: CliState = {
    sessionId: opts.sessionId,
    agent: opts.agent,
    model: opts.model,
    cwd: opts.cwd,
    resume: opts.resume,
    permissionMode: opts.permissionMode,
  };

  const shutdown = (code: number) => {
    conn.close();
    proc?.kill("SIGTERM");
    process.exit(code);
  };

  // One-shot mode: run a single turn and exit with a meaningful code.
  if (opts.prompt) {
    try {
      const ok = await runTurn(conn, state, opts.prompt);
      shutdown(ok ? 0 : 1);
    } catch (err) {
      console.error(`${c.red}Turn failed: ${err instanceof Error ? err.message : err}${c.reset}`);
      shutdown(1);
    }
    return;
  }

  // REPL mode
  console.log(
    `${c.dim}session=${state.sessionId} agent=${state.agent} cwd=${state.cwd}\n` +
      `commands: .agent <a> · .model <m> · .session <id> · .cancel · .exit${c.reset}\n`
  );
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.cyan}› ${c.reset}`,
  });
  let running = false;
  let stdinEnded = false;

  // A line queue instead of rl.question: piped input delivers every line up
  // front (and EOF closes readline) — question() would drop lines that arrive
  // while a turn is running.
  const pendingLines: string[] = [];

  const handleInput = async (input: string): Promise<"continue" | "exit"> => {
    if (input === ".exit" || input === ".quit") return "exit";
    if (input === ".cancel") {
      await conn.client.cancelTurn(state.sessionId).catch(() => {});
      return "continue";
    }
    if (input.startsWith(".agent ")) {
      const agent = input.slice(7).trim();
      if (isAgentHarness(agent)) {
        state.agent = agent;
        state.resume = undefined;
        state.sessionId = generateUUIDv7();
        console.log(`${c.dim}agent=${agent} (new session ${state.sessionId})${c.reset}`);
      } else console.log(`${c.red}unknown agent${c.reset}`);
      return "continue";
    }
    if (input.startsWith(".model ")) {
      state.model = input.slice(7).trim() || undefined;
      console.log(`${c.dim}model=${state.model ?? "(default)"}${c.reset}`);
      return "continue";
    }
    if (input.startsWith(".session ")) {
      state.sessionId = input.slice(9).trim();
      state.resume = undefined;
      console.log(`${c.dim}session=${state.sessionId}${c.reset}`);
      return "continue";
    }
    running = true;
    try {
      await runTurn(conn, state, input);
    } catch (err) {
      console.error(`${c.red}${err instanceof Error ? err.message : err}${c.reset}`);
    } finally {
      running = false;
    }
    return "continue";
  };

  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (pendingLines.length) {
        const input = pendingLines.shift()!.trim();
        if (!input) continue;
        if ((await handleInput(input)) === "exit") return shutdown(0);
      }
    } finally {
      pumping = false;
    }
    if (stdinEnded) return shutdown(0);
    rl.prompt();
  };

  rl.on("line", (line) => {
    // Control commands act immediately — a running turn holds the pump, and
    // .cancel serialized behind the turn it should cancel is useless.
    if (line.trim() === ".cancel" && running) {
      console.log(`${c.yellow}Cancelling turn…${c.reset}`);
      void conn.client.cancelTurn(state.sessionId).catch(() => {});
      return;
    }
    pendingLines.push(line);
    void pump();
  });
  rl.on("close", () => {
    stdinEnded = true;
    void pump();
  });
  rl.on("SIGINT", () => {
    if (running) {
      console.log(`\n${c.yellow}Cancelling turn…${c.reset}`);
      void conn.client.cancelTurn(state.sessionId);
    } else {
      shutdown(0);
    }
  });

  rl.prompt();
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err instanceof Error ? err.message : err}${c.reset}`);
  process.exit(1);
});
