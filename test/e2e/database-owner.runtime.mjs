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
const fixturePids = new Set();

function launch(preload) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", `./test/e2e/lib/${preload}.mjs`, "apps/backend/src/server.ts"],
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
        GIT_CEILING_DIRECTORIES: directory,
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

async function expectFailedShutdown({ child, line }, diagnostic) {
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await line("Closing database connection");
  assert.deepEqual(await closed, [1, null]);
  assert.match(stderr, diagnostic);
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

  const old = launch("stuck-harness");
  host = await connectBackend(`http://127.0.0.1:${await old.line("[BACKEND_PORT]")}`);
  await host.write("sendMessage", {
    sessionId: "chat",
    content: "Hold this turn",
    agentHarness: "codex-app-server",
    model: "gpt-5.4",
  });
  const agentPid = Number(await old.line("[STUCK_AGENT_PID]"));
  const childPid = Number(await old.line("[STUCK_CHILD_PID]"));
  for (const pid of [agentPid, childPid]) {
    assert(Number.isInteger(pid) && pid > 1);
    process.kill(pid, 0);
    fixturePids.add(pid);
  }
  const shutdownStarted = performance.now();
  old.child.stdout.destroy();
  old.child.stderr.destroy();
  old.child.stdin.end();
  const next = launch("throw-on-teardown");
  await next.line("Opening database:");
  assert.equal(old.child.exitCode, null, "The replacement must contend with a live backend");
  assert.deepEqual(await old.exited, [0, null]);
  for (const pid of fixturePids) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `PID ${pid} outlived the backend`);
    fixturePids.delete(pid);
  }
  const port = await next.line("[BACKEND_PORT]");
  assert((await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
  const seconds = ((performance.now() - shutdownStarted) / 1_000).toFixed(1);
  console.log(
    `Stuck agent ${agentPid} and child ${childPid} gone at backend exit. Replacement healthy after ${seconds}s.`
  );

  await expectFailedShutdown(next, /Shutdown failed: Error: fixture device disconnect failed/);
  const recovered = launch("reject-engine-shutdown");
  const recoveredPort = await recovered.line("[BACKEND_PORT]");
  assert((await fetch(`http://127.0.0.1:${recoveredPort}/api/health`)).ok);
  console.log("Teardown failure exited 1. Replacement acquired the database and served health.");
  await expectFailedShutdown(recovered, /Engine shutdown failed: Error: fixture engine rejection/);
  console.log("Engine shutdown rejection was logged and the backend exited 1.");
} finally {
  host?.close();
  for (const { child } of children) child.stdin.end();
  await Promise.all(children.map(({ exited }) => exited));
  for (const pid of fixturePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") console.error(`Could not clean up fixture PID ${pid}`, error);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
