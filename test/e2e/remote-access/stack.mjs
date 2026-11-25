// The real remote-access stack on loopback: Postgres (disposable container),
// Deus Cloud from the linked AGNT worktree, the relay Worker, and Deus backends.
// Sessions are minted with the stack's own JWT secret in the exact shape Deus
// Cloud issues after WorkOS sign-in; WorkOS itself is the one part not run.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SCHEMA_SQL } from "../../../shared/schema.ts";
import { LOOPBACK_WEB_ORIGINS } from "../../../shared/web-origins.ts";
import { connectBackend } from "../lib/operations.mjs";

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(predicate, milliseconds = 20_000, label = "condition") {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    try {
      if (await predicate()) return;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await pause(50);
  }
}

export async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function createStack({ root, agnt, directory }) {
  const processes = new Set();
  const cleanups = [];

  /** `stdin`, when given, is written to the child's stdin, which stays open. */
  function run(command, args, name, { cwd = root, env = {}, stdin } = {}) {
    const log = createWriteStream(path.join(directory, `${name}.log`), { flags: "a" });
    const child = spawn(command, args, {
      cwd,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const owned = { child, log, name };
    processes.add(owned);
    return owned;
  }

  async function stop(owned) {
    processes.delete(owned);
    if (owned.child.exitCode === null && owned.child.signalCode === null) {
      const exited = once(owned.child, "exit");
      owned.child.kill("SIGTERM");
      const timer = setTimeout(() => owned.child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    }
    owned.log.end();
  }

  async function postgres() {
    const port = await freePort();
    const name = `deus-remote-access-e2e-${process.pid}-${Date.now()}`;
    const started = spawnSync("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:5432`,
      "-e",
      "POSTGRES_USER=agnt",
      "-e",
      "POSTGRES_PASSWORD=agnt",
      "-e",
      "POSTGRES_DB=agnt",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "postgres:16-alpine",
    ]);
    assert.equal(started.status, 0, `docker run failed: ${started.stderr}`);
    cleanups.push(() => spawnSync("docker", ["rm", "-f", name]));
    await until(
      () => spawnSync("docker", ["exec", name, "pg_isready", "-U", "agnt"]).status === 0,
      30_000,
      "Postgres"
    );
    // pg_isready can answer before the TCP listener accepts the migration client.
    await until(
      () =>
        spawnSync("docker", ["exec", name, "psql", "-U", "agnt", "-d", "agnt", "-c", "select 1"])
          .status === 0,
      30_000,
      "Postgres queries"
    );
    const url = `postgres://agnt:agnt@127.0.0.1:${port}/agnt`;
    const migrated = spawnSync("bunx", ["--bun", "drizzle-kit", "migrate"], {
      cwd: path.join(agnt, "apps/backend"),
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
    assert.equal(migrated.status, 0, `AGNT migrations failed: ${migrated.stderr}`);
    const sql = (statement) => {
      const result = spawnSync(
        "docker",
        [
          "exec",
          name,
          "psql",
          "-U",
          "agnt",
          "-d",
          "agnt",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          statement,
        ],
        { encoding: "utf8" }
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    return { url, sql };
  }

  async function keys() {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const kid = `e2e-${Date.now()}`;
    const { kty, crv, x, y } = await exportJWK(publicKey);
    return {
      signingKey: JSON.stringify({ ...(await exportJWK(privateKey)), kid }),
      jwks: JSON.stringify({ keys: [{ kty, crv, x, y, kid, alg: "ES256", use: "sig" }] }),
    };
  }

  async function worker({ name, config, port, persist, wrangler, cwd, env = {}, args = [] }) {
    const file =
      typeof config === "string" ? config : path.join(directory, `${name}.wrangler.json`);
    if (typeof config !== "string") await writeFile(file, JSON.stringify(config, null, 2));
    const owned = run(
      process.execPath,
      [
        wrangler,
        "dev",
        "--config",
        file,
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        persist,
        "--log-level",
        "warn",
        ...args,
      ],
      name,
      { cwd, env: { WRANGLER_SEND_METRICS: "false", ...env } }
    );
    const base = `http://127.0.0.1:${port}`;
    await until(
      async () => {
        assert.equal(owned.child.exitCode, null, `${name} exited; see ${name}.log`);
        return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
      },
      90_000,
      name
    );
    return { ...owned, base };
  }

  /**
   * Deus Cloud from the AGNT worktree, with only what remote access needs
   * configured; `vars` adds more (the assistants test's issuer and relay).
   */
  async function cloud({ port, databaseUrl, jwtSecret, signingKey, persist, vars = {} }) {
    return worker({
      name: `cloud-${port}`,
      port,
      persist,
      cwd: path.join(agnt, "apps/deus-cloud"),
      wrangler: path.join(agnt, "apps/deus-cloud/node_modules/wrangler/bin/wrangler.js"),
      env: { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl },
      config: {
        name: "deus-cloud-e2e",
        main: path.join(agnt, "apps/deus-cloud/src/index.ts"),
        compatibility_date: "2025-01-01",
        compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
        vars: {
          DEUS_CLOUD_URL: `http://127.0.0.1:${port}`,
          JWT_SECRET: jwtSecret,
          RELAY_TICKET_SIGNING_KEY: signingKey,
          ENCRYPTION_KEY: "a".repeat(64),
          ...vars,
        },
        hyperdrive: [{ binding: "HYPERDRIVE", id: "remote-access-e2e" }],
        durable_objects: {
          bindings: [
            { name: "PROVIDER_ACCOUNTS", class_name: "ProviderAccounts" },
            { name: "REMOTE_MACHINES", class_name: "RemoteMachines" },
          ],
        },
        migrations: [
          { tag: "provider-accounts-v1", new_sqlite_classes: ["ProviderAccounts"] },
          { tag: "remote-machines-v1", new_sqlite_classes: ["RemoteMachines"] },
        ],
      },
    });
  }

  async function relay({ port, jwks, persist }) {
    // Select the fixture environment explicitly so a checkout's .dev.vars cannot enter this stack.
    const envFile = path.join(directory, `relay-${port}.env`);
    await writeFile(envFile, `ENVIRONMENT=e2e\nRELAY_TICKET_JWKS=${jwks}\n`);
    const owned = await worker({
      name: `relay-${port}`,
      port,
      persist,
      wrangler: path.join(root, "apps/cloud-relay/node_modules/wrangler/bin/wrangler.js"),
      config: path.join(root, "apps/cloud-relay/wrangler.toml"),
      env: {
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      },
      args: ["--name", "deus-relay-e2e", "--env-file", envFile],
    });
    return { ...owned, ws: `ws://127.0.0.1:${port}` };
  }

  /** A Deus backend with its own SQLite database and a ready workspace. */
  async function hostDatabase(name, title) {
    const dir = path.join(directory, name);
    spawnSync("mkdir", ["-p", dir]);
    const database = path.join(dir, "deus.db");
    const db = new Database(database);
    db.exec(SCHEMA_SQL);
    const repository = crypto.randomUUID();
    const workspace = crypto.randomUUID();
    db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'Remote test', ?)").run(
      repository,
      dir
    );
    db.prepare(
      "INSERT INTO workspaces (id, repository_id, slug, title, state) VALUES (?, ?, 'remote', ?, 'ready')"
    ).run(workspace, repository, title);
    db.close();
    await writeFile(
      path.join(dir, "preferences.json"),
      JSON.stringify({
        onboarding_completed: true,
        remote_access_enabled: true,
        server_name: name,
      })
    );
    return { dir, database, workspace };
  }

  /** `env` adds to the backend's environment (the assistants test's issuer). */
  async function host({ name, database, dir, relayUrl, authToken, env = {} }) {
    const owned = run(process.execPath, ["--import", "tsx", "apps/backend/src/server.ts"], name, {
      env: {
        PORT: "0",
        DATABASE_PATH: database,
        DEUS_RELAY_URL: relayUrl,
        TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
        AGNT_API_KEY: "",
        DEUS_CLOUD_AGNT_API_KEY: "",
        DEUS_CLOUD_URL: "",
        // As the desktop app spawns it: the token credentials must carry is
        // the first line on its stdin.
        ...(authToken ? { DEUS_STOP_ON_STDIN_END: "1" } : {}),
        DEUS_SKILLS_HOME: path.join(dir, "skills-home"),
        // Never the person's login Keychain: the vault's key goes in a file beside the database.
        DEUS_VAULT_NO_KEYCHAIN: "1",
        // No agent engine: no harness CLI is started, so no model turn can run or be paid for.
        AGENT_ALLOW_AGENTLESS: "1",
        // The run's folders sit inside this repository's checkout: git must not find
        // the checkout from a test folder that is not a repository of its own.
        GIT_CEILING_DIRECTORIES: directory,
        // The Mac's own web app (browser.mjs serves it from Vite on loopback).
        DEUS_WEB_ORIGINS: LOOPBACK_WEB_ORIGINS,
        ...env,
      },
      ...(authToken ? { stdin: `${authToken}\n` } : {}),
    });
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`${name} startup timed out`)), 60_000);
      owned.child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`${name} exited ${code}`));
      });
      owned.child.stdout.on("data", (data) => {
        output += String(data);
        const match = output.match(/^\[BACKEND_PORT\](\d+)$/m);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });
    const url = `http://127.0.0.1:${port}`;
    const api = async (route, { method = "GET", body, headers = {} } = {}) => {
      const response = await fetch(`${url}/api${route}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        signal: AbortSignal.timeout(10_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => null);
      assert(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
      return data;
    };
    /** An operation, as this computer's window sends it. */
    const write = async (name, params) => {
      const backend = await connectBackend(url);
      return backend.write(name, params).finally(backend.close);
    };
    return { ...owned, url, api, write };
  }

  /** A Deus Cloud session exactly as `session-issuer.ts` signs it. */
  async function session(jwtSecret, accountId, client, ttlSeconds = 3600) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ type: "deus_cloud_session", client })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("deus-cloud")
      .setAudience("agnt-backend")
      .setSubject(accountId)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(new TextEncoder().encode(jwtSecret));
  }

  async function close() {
    for (const owned of [...processes].reverse()) await stop(owned);
    for (const cleanup of cleanups.reverse()) cleanup();
  }

  return { run, stop, postgres, keys, cloud, relay, hostDatabase, host, session, close };
}
