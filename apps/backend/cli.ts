#!/usr/bin/env bun
// backend/cli.ts
// Self-contained CLI that tests the full event → persistence pipeline
// WITHOUT the frontend: the standard wire + the backend's REAL translation.
//
// 1. Creates a workspace + session in the real DB (via sqlite3 CLI)
// 2. Spawns the agent-server bundle
// 3. Connects backend-style (AgentServerClient + deus side channel + hello)
// 4. Starts a turn with the backend's REAL run-config assembly
// 5. Feeds every envelope through the backend's REAL LifecycleTranslator and
//    persists the resulting AgentEvents (mimicking the event handler's SQL)
// 6. Dumps the DB to verify everything stored correctly
//
// Usage:
//   bun run cli:backend -- "Say hello"
//   bun run cli:backend --db-only           # just dump latest session

import { spawn, execSync, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { AgentServerClient } from "@zvada/agent-server/client";
import {
  SIDE_CHANNEL,
  SideChannelEndpoint,
  claimSideChannel,
  wsLineTransport,
} from "@shared/agent-side-channel";
import type { AgentEvent } from "@shared/agent-events";
import type { AgentHarness } from "@shared/enums";
import { LifecycleTranslator } from "./src/services/agent/translate/translator";
import { buildTurnStartParams } from "./src/services/agent/run-config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY;
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

function ts(): string {
  const now = new Date();
  return `${c.dim}${now.toLocaleTimeString("en-US", { hour12: false })}.${String(now.getMilliseconds()).padStart(3, "0")}${c.reset}`;
}

function banner(text: string) {
  const line = "─".repeat(Math.max(0, 60 - text.length));
  console.log(`\n${c.dim}──${c.reset} ${c.bold}${text}${c.reset} ${c.dim}${line}${c.reset}`);
}

// ---------------------------------------------------------------------------
// DB via sqlite3 CLI (avoids better-sqlite3 Node version mismatch)
// ---------------------------------------------------------------------------

function getDbPath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "com.deus.app", "deus.db");
}

function sql(dbPath: string, query: string): string {
  try {
    return execSync(`sqlite3 "${dbPath}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function sqlRun(dbPath: string, query: string): boolean {
  // Write SQL to temp file to avoid shell escaping issues with JSON data
  const tmpFile = path.join(os.tmpdir(), `deus-cli-${Date.now()}.sql`);
  try {
    fs.writeFileSync(tmpFile, query);
    execSync(`sqlite3 "${dbPath}" < "${tmpFile}"`, { timeout: 5000 });
    return true;
  } catch (err: any) {
    console.log(`  ${c.red}DB ERROR: ${err.message?.split("\n")[0]}${c.reset}`);
    return false;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

function ensureSchema(dbPath: string) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Import schema from shared
  const schemaPath = path.resolve(__dirname, "../../shared/schema.ts");
  const schemaContent = fs.readFileSync(schemaPath, "utf-8");

  // Extract SCHEMA_SQL from the file. Pre-launch schema changes update the
  // source schema directly; stale local DBs should be reset rather than migrated.
  const schemaMatch = schemaContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
  if (schemaMatch) {
    const schemaSql = schemaMatch[1];
    try {
      execSync(`sqlite3 "${dbPath}" "${schemaSql.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, {
        timeout: 5000,
      });
    } catch {
      /* tables already exist */
    }
  }
}

// ---------------------------------------------------------------------------
// UUID7 (simple timestamp-based)
// ---------------------------------------------------------------------------

function uuid7(): string {
  const now = Date.now();
  const hex = now.toString(16).padStart(12, "0");
  const rand = Math.random().toString(16).slice(2, 14);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${rand.slice(3, 7)}-${rand.slice(7, 19).padEnd(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let dbOnly = false;
  let pastSep = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" && !pastSep) {
      pastSep = true;
      continue;
    }
    if (arg === "--db-only") {
      dbOnly = true;
      continue;
    }
    if (!pastSep && arg.startsWith("--") && i + 1 < args.length) {
      opts[arg.slice(2)] = args[++i];
    } else {
      positional.push(arg);
    }
  }

  return {
    agent: opts.agent || "claude",
    cwd: opts.cwd || process.cwd(),
    prompt: positional.join(" ") || "Say exactly: HELLO WORLD. No skills or agents.",
    dbOnly,
  };
}

// ---------------------------------------------------------------------------
// DB dump
// ---------------------------------------------------------------------------

function dumpSession(dbPath: string, sessionId: string): number {
  banner("Database State");

  console.log(`\n  ${c.bold}Messages${c.reset}`);
  const messages = sql(
    dbPath,
    `SELECT id, role, stop_reason, seq FROM messages WHERE session_id='${sessionId}' ORDER BY seq;`
  );
  if (messages) {
    for (const line of messages.split("\n")) {
      const [id, role, stopReason, seq] = line.split("|");
      const stop = stopReason ? ` ${c.yellow}stop=${stopReason}${c.reset}` : "";
      console.log(`  ${c.cyan}${role}${c.reset} seq=${seq}${stop} ${c.dim}${id}${c.reset}`);
    }
  } else {
    console.log(`  ${c.red}No messages${c.reset}`);
  }

  console.log(`\n  ${c.bold}Parts${c.reset}`);
  const parts = sql(
    dbPath,
    `SELECT p.type, p.tool_name, p.seq, substr(p.data, 1, 80) FROM parts p JOIN messages m ON p.message_id=m.id WHERE m.session_id='${sessionId}' ORDER BY m.seq, p.seq;`
  );
  if (parts) {
    for (const line of parts.split("\n")) {
      const [type, toolName, seq, data] = line.split("|");
      const tool = toolName ? ` ${c.yellow}${toolName}${c.reset}` : "";
      console.log(`  ${c.green}${type}${c.reset}${tool} seq=${seq}`);
      console.log(`    ${c.dim}${data}${c.reset}`);
    }
  } else {
    console.log(`  ${c.red}No parts${c.reset}`);
  }

  const partCount = parseInt(
    sql(dbPath, `SELECT count(*) FROM parts WHERE session_id='${sessionId}';`) || "0",
    10
  );
  const msgCount = parseInt(
    sql(dbPath, `SELECT count(*) FROM messages WHERE session_id='${sessionId}';`) || "0",
    10
  );
  const partTypes = sql(
    dbPath,
    `SELECT type || '×' || count(*) FROM parts WHERE session_id='${sessionId}' GROUP BY type;`
  );

  console.log(`\n  Messages: ${c.bold}${msgCount}${c.reset}`);
  console.log(
    `  Parts:    ${c.bold}${partCount}${c.reset}${partTypes ? ` (${partTypes.split("\n").join(", ")})` : ""}`
  );

  return partCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const dbPath = getDbPath();

  // DB-only mode
  if (opts.dbOnly) {
    const lastSession = sql(dbPath, `SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1;`);
    if (!lastSession) {
      console.log(`${c.red}No sessions in DB${c.reset}`);
      process.exit(1);
    }
    console.log(`  ${c.dim}Session: ${lastSession}${c.reset}`);
    const pc = dumpSession(dbPath, lastSession);
    process.exit(pc > 0 ? 0 : 1);
  }

  banner("Backend Integration CLI");
  console.log(`  agent:  ${c.bold}${opts.agent}${c.reset}`);
  console.log(`  prompt: ${c.dim}${opts.prompt}${c.reset}`);
  console.log(`  db:     ${c.dim}${dbPath}${c.reset}`);

  // 1. Ensure DB schema
  ensureSchema(dbPath);

  // 2. Create workspace + session
  const repoId = uuid7();
  const workspaceId = uuid7();
  const sessionId = `cli-${Date.now()}`;

  sqlRun(
    dbPath,
    `INSERT OR IGNORE INTO repositories (id, path, name) VALUES ('${repoId}', '${opts.cwd.replace(/'/g, "''")}', 'cli-test');`
  );
  sqlRun(
    dbPath,
    `INSERT OR IGNORE INTO workspaces (id, repository_id, name, branch, worktree_path, state) VALUES ('${workspaceId}', '${repoId}', 'cli-test', 'main', '${opts.cwd.replace(/'/g, "''")}', 'ready');`
  );
  sqlRun(
    dbPath,
    `INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES ('${sessionId}', '${workspaceId}', '${opts.agent}', 'idle');`
  );

  // Insert user message
  const userMsgId = uuid7();
  sqlRun(
    dbPath,
    `INSERT INTO messages (id, session_id, role, content, sent_at) VALUES ('${userMsgId}', '${sessionId}', 'user', '${opts.prompt.replace(/'/g, "''")}', datetime('now'));`
  );

  console.log(`  ${c.green}Session created:${c.reset} ${sessionId}`);

  // 3. Spawn agent-server
  const bundlePath = path.resolve(__dirname, "../agent-server/dist/index.bundled.cjs");
  if (!fs.existsSync(bundlePath)) {
    console.error(`${c.red}Run: bun run build:agent-server${c.reset}`);
    process.exit(1);
  }

  const proc = spawn("node", [bundlePath], {
    env: { ...process.env, LOG_LEVEL: "info" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr?.on("data", () => {});

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
  });
  console.log(`  ${c.green}Agent-server:${c.reset} ${wsUrl}`);

  // 4. Connect backend-style: typed client + deus side channel + hello
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const transport = wsLineTransport(ws);

  const sideChannel = new SideChannelEndpoint((line) => transport.send(line), "cli-backend");
  sideChannel.onRequest(SIDE_CHANNEL.exitPlanMode, () => ({ approved: true }));
  sideChannel.onNotification(SIDE_CHANNEL.title, (params) => {
    const { title } = (params ?? {}) as { title?: string };
    console.log(`${ts()} ${c.magenta}◂ deus/title${c.reset} "${title}"`);
  });
  sideChannel.notify(SIDE_CHANNEL.hello, {});

  const client = await AgentServerClient.attach(claimSideChannel(transport, sideChannel));
  const init = await client.initialize();
  console.log(
    `  ${c.green}Handshake:${c.reset} v${init.protocolVersion} harnesses=[${Object.keys(init.harnesses).join(", ")}]`
  );

  // 5. The backend's REAL translation: LifecycleEvent envelopes → AgentEvents,
  // persisted with the same SQL shapes the event handler uses.
  let turnDone = false;
  let partSeq = 0;

  banner("Events");

  const handleAgentEvent = (event: AgentEvent): void => {
    let color = c.cyan;
    if (event.type.startsWith("turn.") || event.type.startsWith("session.")) color = c.magenta;
    if (event.type.startsWith("part.")) color = c.green;
    if (event.type.startsWith("message.")) color = c.blue;
    if (event.type.includes("error")) color = c.red;

    let detail = "";
    switch (event.type) {
      case "message.created":
        detail = `messageId=${event.messageId}`;
        sqlRun(
          dbPath,
          `INSERT OR REPLACE INTO messages (id, session_id, role, sent_at) VALUES ('${event.messageId}', '${sessionId}', 'assistant', datetime('now'));`
        );
        detail += ` ${c.green}→ DB INSERT${c.reset}`;
        break;

      case "part.created":
        detail = `${event.part.type} partId=${event.partId}`;
        break;

      case "part.delta":
        detail = `delta="${(event.delta || "").slice(0, 40)}"`;
        break;

      case "part.done": {
        const part = event.part;
        const partData = JSON.stringify(part).replace(/'/g, "''");
        const toolCallId = part.type === "TOOL" ? part.toolCallId || "" : "";
        const toolName = part.type === "TOOL" ? part.toolName || "" : "";
        const parentId = part.parentToolCallId || "";
        const ok = sqlRun(
          dbPath,
          `INSERT OR REPLACE INTO parts (id, message_id, session_id, seq, type, data, tool_call_id, tool_name, parent_tool_call_id) VALUES ('${event.partId}', '${event.messageId}', '${sessionId}', ${partSeq++}, '${part.type}', '${partData}', '${toolCallId}', '${toolName}', '${parentId}');`
        );
        detail = `${part.type} partId=${event.partId} ${ok ? `${c.green}→ DB INSERT${c.reset}` : `${c.red}→ DB FAIL${c.reset}`}`;
        break;
      }

      case "message.done":
        detail = `stopReason=${event.stopReason || "none"}`;
        sqlRun(
          dbPath,
          `UPDATE messages SET stop_reason='${event.stopReason || ""}' WHERE id='${event.messageId}';`
        );
        detail += ` ${c.green}→ DB UPDATE${c.reset}`;
        break;

      case "turn.completed":
        detail = `finishReason=${event.finishReason || "none"}`;
        break;

      case "agent.session_id":
        detail = `agentSessionId=${event.agentSessionId}`;
        sqlRun(
          dbPath,
          `UPDATE sessions SET agent_session_id='${event.agentSessionId}' WHERE id='${sessionId}';`
        );
        detail += ` ${c.green}→ DB UPDATE${c.reset}`;
        break;

      case "session.idle":
        sqlRun(dbPath, `UPDATE sessions SET status='idle' WHERE id='${sessionId}';`);
        turnDone = true;
        detail = "→ turn complete";
        break;

      case "session.cancelled":
        turnDone = true;
        detail = "→ cancelled";
        break;

      case "session.error":
        detail = event.error || "unknown";
        turnDone = true;
        break;

      default:
        detail = JSON.stringify(event).slice(0, 50);
    }

    console.log(`${ts()} ${c.green}◂${c.reset} ${color}${c.bold}${event.type}${c.reset} ${detail}`);
  };

  const translator = new LifecycleTranslator({ emit: handleAgentEvent });
  client.onEvent((envelope) => translator.handle(envelope));

  // 6. Start the turn with the backend's REAL run-config assembly
  banner("Sending Turn");
  console.log(`  ${c.dim}${opts.prompt}${c.reset}\n`);

  const turnId = uuid7();
  const params = buildTurnStartParams(sessionId, turnId, opts.agent as AgentHarness, opts.prompt, {
    cwd: opts.cwd,
    permissionMode: "default",
  });
  await client.startTurn(params);
  translator.beginTurn(sessionId, opts.agent as AgentHarness, turnId);

  // 7. Wait for completion
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (turnDone) {
        clearInterval(check);
        resolve();
      }
    }, 200);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 120_000);
  });
  await new Promise((r) => setTimeout(r, 1500));

  // 8. Dump DB
  const partCount = dumpSession(dbPath, sessionId);

  // 9. Verdict
  banner("Result");
  console.log(
    partCount > 0
      ? `  ${c.green}${c.bold}PASS${c.reset}: ${partCount} parts persisted to DB`
      : `  ${c.red}${c.bold}FAIL${c.reset}: No parts persisted`
  );

  await client.close();
  ws.close();
  proc.kill("SIGTERM");
  process.exit(partCount > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
