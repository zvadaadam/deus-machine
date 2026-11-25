// Node 22: node --import tsx test/e2e/database-owner.runtime.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { connectBackend } from "./lib/operations.mjs";

const root = resolve(import.meta.dirname, "../..");
await mkdir(join(root, ".context"), { recursive: true });
const directory = await mkdtemp(join(root, ".context/database-owner-"));
const database = join(directory, "deus.db");
const children = [];

function launch() {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./test/e2e/lib/stuck-harness.mjs",
      "apps/backend/src/server.ts",
    ],
    {
      cwd: root,
      env: {
        HOME: directory,
        PATH: process.env.PATH,
        TSX_TSCONFIG_PATH: join(root, "apps/backend/tsconfig.json"),
        DATABASE_PATH: database,
        DEUS_STOP_ON_STDIN_END: "1",
        DEUS_VAULT_NO_KEYCHAIN: "1",
        DEUS_USER_DATA_DIR: directory,
        AGENT_ALLOW_AGENTLESS: "0",
        PORT: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
      killSignal: "SIGKILL",
    }
  );
  child.stderr.pipe(process.stderr);
  const exited = once(child, "exit");
  children.push({ child, exited });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function line(prefix) {
    for (;;) {
      const { value, done } = await lines.next();
      assert(!done, `Backend exited before ${prefix}`);
      if (value.startsWith(prefix)) return value.slice(prefix.length);
    }
  }
  return { child, exited, line };
}

let host;
try {
  await mkdir(join(directory, ".deus/probe"), { recursive: true });
  const db = new Database(database);
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES ('repo', 'Probe', ?)").run(
    directory
  );
  db.exec(`INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('ws', 'repo', 'probe', 'ready');
           INSERT INTO sessions (id, workspace_id, agent_harness) VALUES ('chat', 'ws', 'codex-app-server')`);
  db.close();

  const old = launch();
  host = await connectBackend(`http://127.0.0.1:${await old.line("[BACKEND_PORT]")}`);
  await host.write("sendMessage", {
    sessionId: "chat",
    content: "Hold this turn",
    agentHarness: "codex-app-server",
    model: "gpt-5.4",
  });
  const agentPid = Number(await old.line("[STUCK_AGENT_PID]"));
  process.kill(agentPid, 0);
  const shutdownStarted = performance.now();
  old.child.stdout.destroy();
  old.child.stderr.destroy();
  old.child.stdin.end();
  const next = launch();
  await next.line("Opening database:");
  assert.equal(old.child.exitCode, null, "The replacement must contend with a live backend");
  assert.deepEqual(await old.exited, [0, null]);
  assert.throws(() => process.kill(agentPid, 0), { code: "ESRCH" });
  const port = await next.line("[BACKEND_PORT]");
  assert((await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
  const seconds = ((performance.now() - shutdownStarted) / 1_000).toFixed(1);
  console.log(
    `Stuck agent ${agentPid} gone at backend exit. Replacement healthy after ${seconds}s.`
  );
} finally {
  host?.close();
  for (const { child } of children) child.stdin.end();
  await Promise.all(children.map(({ exited }) => exited));
  await rm(directory, { recursive: true, force: true });
}
