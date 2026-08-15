#!/usr/bin/env bun
// backend/cli.ts
// Self-contained CLI that tests the full event → persistence pipeline
// WITHOUT the frontend: the standard wire + the backend's REAL persistence.
//
// 1. Creates a workspace + session in the DB (the backend's own connection)
// 2. Spawns the agent-server bundle
// 3. Connects backend-style (AgentServerClient + deus side channel + hello)
// 4. Starts a turn with the backend's REAL run-config assembly
// 5. Feeds every envelope through `services/agent/persistence.ts` — the SAME
//    functions the event handler calls, not a copy of their SQL. A harness
//    that verifies a re-implementation verifies nothing: the clone drifted
//    (it carried the INSERT OR REPLACE that cascade-deleted parts on replay
//    long after persistence.ts was fixed).
// 6. Dumps the DB to verify everything stored correctly
//
// Runs on Bun, so the DB goes through bun:sqlite (see lib/sqlite.ts) —
// better-sqlite3's native addon crashes the Bun process.
//
// Usage:
//   bun run cli:backend -- "Say hello"
//   bun run cli:backend --db-only           # just dump latest session

import { spawn, type ChildProcess } from "child_process";
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
import type { AgentHarness } from "@shared/enums";
import { isUnknownLifecycleEvent, type AnyLifecycleEvent } from "@shared/protocol-types";
import { buildTurnStartParams } from "./src/services/agent/run-config";
import { turnOutcome } from "./src/services/agent/event-handler";
import { uuidv7 } from "@shared/lib/uuid";
import { DB_PATH, closeDatabase, getDatabase, initDatabase } from "./src/lib/database";
import {
  persistAgentSessionId,
  persistCompaction,
  persistMessageStarted,
  persistPart,
  persistSessionError,
  persistTurnEnded,
} from "./src/services/agent/persistence";

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
// DB — the backend's own connection, schema and writes
//
// No sqlite3 subprocess and no hand-rolled SQL: `initDatabase()` applies
// SCHEMA_SQL, the additive columns and the pre-launch assertions exactly as the
// server does, and DATABASE_PATH points a verification run at a scratch file.
// ---------------------------------------------------------------------------

function openDatabase() {
  try {
    initDatabase();
  } catch (err) {
    console.log(`  ${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    process.exit(1);
  }
  return getDatabase();
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
    agent: opts.agent || "claude-code",
    cwd: opts.cwd || process.cwd(),
    prompt: positional.join(" ") || "Say exactly: HELLO WORLD. No skills or agents.",
    dbOnly,
  };
}

// ---------------------------------------------------------------------------
// DB dump
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  role: string;
  turn_stop_reason: string | null;
  seq: number;
  cancelled_at: string | null;
  tokens: string | null;
}

interface PartRow {
  type: string;
  tool_name: string | null;
  seq: number;
  data: string;
}

function dumpSession(sessionId: string): number {
  const db = getDatabase();
  banner("Database State");

  console.log(`\n  ${c.bold}Messages${c.reset}`);
  const messages = db
    .prepare(
      `SELECT id, role, turn_stop_reason, seq, cancelled_at, tokens
         FROM messages WHERE session_id = ? ORDER BY seq`
    )
    .all(sessionId) as MessageRow[];
  if (messages.length) {
    for (const row of messages) {
      const stop = row.turn_stop_reason ? ` ${c.yellow}stop=${row.turn_stop_reason}${c.reset}` : "";
      const cancelled = row.cancelled_at ? ` ${c.red}cancelled${c.reset}` : "";
      const tokens = row.tokens ? ` ${c.dim}tokens=${row.tokens}${c.reset}` : "";
      console.log(
        `  ${c.cyan}${row.role}${c.reset} seq=${row.seq}${stop}${cancelled}${tokens} ${c.dim}${row.id}${c.reset}`
      );
    }
  } else {
    console.log(`  ${c.red}No messages${c.reset}`);
  }

  console.log(`\n  ${c.bold}Parts${c.reset}`);
  const parts = db
    .prepare(
      `SELECT p.type, p.tool_name, p.seq, p.data FROM parts p JOIN messages m ON p.message_id = m.id
        WHERE m.session_id = ? ORDER BY m.seq, p.seq`
    )
    .all(sessionId) as PartRow[];
  if (parts.length) {
    for (const row of parts) {
      const tool = row.tool_name ? ` ${c.yellow}${row.tool_name}${c.reset}` : "";
      console.log(`  ${c.green}${row.type}${c.reset}${tool} seq=${row.seq}`);
      console.log(`    ${c.dim}${row.data.slice(0, 80)}${c.reset}`);
    }
  } else {
    console.log(`  ${c.red}No parts${c.reset}`);
  }

  const byType = db
    .prepare(`SELECT type, count(*) as n FROM parts WHERE session_id = ? GROUP BY type`)
    .all(sessionId) as Array<{ type: string; n: number }>;
  const partCount = byType.reduce((total, row) => total + row.n, 0);

  console.log(`\n  Messages: ${c.bold}${messages.length}${c.reset}`);
  console.log(
    `  Parts:    ${c.bold}${partCount}${c.reset}${
      byType.length ? ` (${byType.map((r) => `${r.type}×${r.n}`).join(", ")})` : ""
    }`
  );

  return partCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  // DB-only mode
  if (opts.dbOnly) {
    const db = openDatabase();
    const last = db.prepare(`SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1`).get() as
      | { id: string }
      | undefined;
    if (!last) {
      console.log(`${c.red}No sessions in DB${c.reset}`);
      process.exit(1);
    }
    console.log(`  ${c.dim}Session: ${last.id}${c.reset}`);
    const pc = dumpSession(last.id);
    process.exit(pc > 0 ? 0 : 1);
  }

  banner("Backend Integration CLI");
  console.log(`  agent:  ${c.bold}${opts.agent}${c.reset}`);
  console.log(`  prompt: ${c.dim}${opts.prompt}${c.reset}`);
  console.log(`  db:     ${c.dim}${DB_PATH}${c.reset}`);

  // 1. Open the DB the way the backend does (schema + assertions included)
  const db = openDatabase();

  // 2. Create workspace + session
  const repoId = uuidv7();
  const workspaceId = uuidv7();
  const sessionId = `cli-${Date.now()}`;

  db.prepare(
    `INSERT OR IGNORE INTO repositories (id, name, root_path) VALUES (?, 'cli-test', ?)`
  ).run(repoId, opts.cwd);
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, repository_id, slug, state) VALUES (?, ?, 'cli-test', 'ready')`
  ).run(workspaceId, repoId);
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES (?, ?, ?, 'working')`
  ).run(sessionId, workspaceId, opts.agent);

  // No user message row is seeded: the engine echoes the prompt back as
  // message.started{role:"user"} and THAT is what persists it. The session
  // starts 'working' for the same reason the send command flips it there —
  // turn.ended is what settles it.

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

  // 5. The canonical stream, through the backend's REAL persistence functions.
  // Not a copy of their SQL — the functions themselves, so this harness cannot
  // pass while the shipped writes are broken.
  let turnDone = false;
  let errorReported = false;

  banner("Events");

  const handleEvent = (event: AnyLifecycleEvent): void => {
    let color = c.cyan;
    if (event.type.startsWith("turn.") || event.type.startsWith("session.")) color = c.magenta;
    if (event.type.startsWith("message.part")) color = c.green;
    if (event.type.startsWith("message.")) color = c.blue;
    if (event.type === "error") color = c.red;

    let detail = "";
    const wrote = (result: { ok: boolean; error?: string }) =>
      result.ok ? ` ${c.green}→ DB${c.reset}` : ` ${c.red}→ DB FAIL: ${result.error}${c.reset}`;

    if (isUnknownLifecycleEvent(event)) {
      // Law 6: preserved, never dropped — the backend forwards it too.
      detail = `${c.yellow}unknown type${c.reset} ${JSON.stringify(event.raw).slice(0, 50)}`;
    } else {
      switch (event.type) {
        case "session.created":
          detail =
            `native=${event.nativeSessionId}${event.resumed === false ? " resumed=false" : ""}` +
            wrote(persistAgentSessionId(sessionId, event.nativeSessionId));
          break;

        case "message.started":
          detail =
            `${event.role} messageId=${event.messageId}` + wrote(persistMessageStarted(event));
          break;

        case "message.part":
          detail = `${event.part.type} partId=${event.part.id}` + wrote(persistPart(event));
          break;

        case "message.part.delta":
          detail = `${event.delta.type} partId=${event.partId}`;
          break;

        case "message.ended":
          detail = `messageId=${event.messageId}`;
          break;

        case "turn.ended":
          detail =
            `stopReason=${event.stopReason}${event.cost !== undefined ? ` cost=${event.cost}` : ""}` +
            wrote(persistTurnEnded(event, turnOutcome(event, errorReported)));
          turnDone = true;
          break;

        case "session.usage":
          detail = `used=${event.used}${event.size ? `/${event.size}` : ""}`;
          break;

        case "session.compaction":
          detail =
            `compactionId=${event.compactionId} status=${event.status}` +
            wrote(persistCompaction(event));
          break;

        case "error":
          detail = `${event.category}${event.recoverable ? " (recoverable)" : ""}: ${event.message}`;
          if (!event.recoverable) {
            // Same swallow the event handler applies: a recoverable error means
            // the turn CONTINUES, and promoting it would suppress the real one.
            errorReported = true;
            detail += wrote(persistSessionError(sessionId, event.message, event.category));
            turnDone = true;
          }
          break;

        default:
          detail = JSON.stringify(event).slice(0, 50);
      }
    }

    console.log(`${ts()} ${c.green}◂${c.reset} ${color}${c.bold}${event.type}${c.reset} ${detail}`);
  };

  client.onEvent((envelope) => handleEvent(envelope.event));

  // 6. Start the turn with the backend's REAL run-config assembly
  banner("Sending Turn");
  console.log(`  ${c.dim}${opts.prompt}${c.reset}\n`);

  const turnId = uuidv7();
  const params = buildTurnStartParams(sessionId, turnId, opts.agent as AgentHarness, opts.prompt, {
    cwd: opts.cwd,
    permissionMode: "default",
    supportsImages: init.harnesses[opts.agent]?.images ?? false,
  });
  await client.startTurn(params);

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
  const partCount = dumpSession(sessionId);

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
  closeDatabase();
  process.exit(partCount > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
