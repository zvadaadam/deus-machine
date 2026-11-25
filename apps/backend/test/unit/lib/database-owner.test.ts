import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const loadDatabase = () => import("../../../src/lib/database");
let directory: string;
let filename: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "deus-db-owner-"));
  filename = join(directory, "deus.db");
  vi.stubEnv("DATABASE_PATH", filename);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEUS_TEST_DB_OWNER_NO_WAIT", "1");
  vi.resetModules();
});

afterEach(async () => {
  (await loadDatabase()).closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("defaults to the checkout's database and honors an explicit override", async () => {
  vi.stubEnv("DEUS_DEV_ROOT", directory);
  vi.stubEnv("DATABASE_PATH", undefined);
  expect((await loadDatabase()).DB_PATH).toBe(join(directory, ".deus-dev", "deus.db"));

  vi.resetModules();
  vi.stubEnv("DATABASE_PATH", filename);
  expect((await loadDatabase()).DB_PATH).toBe(filename);
});

it("the checkout bootstrap discards a database override inherited from packaged Deus", () => {
  const bootstrap = new URL("../../../server.cjs", import.meta.url);
  const databaseUrl = new URL("../../../src/lib/database.ts", import.meta.url);
  const probe = join(directory, "probe-bootstrap.cjs");
  const inspectPath = `import { DB_PATH } from ${JSON.stringify(databaseUrl.href)}; console.log(DB_PATH);`;
  // Keep the actual bootstrap and its preloads. Replace only the child entry
  // point so this test resolves the path without opening any database.
  writeFileSync(
    probe,
    `const childProcess = require('node:child_process');
     const spawn = childProcess.spawn;
     childProcess.spawn = (command, args, options) => spawn(command, [
       ...args.slice(0, -1), '--input-type=module', '--eval',
       ${JSON.stringify(inspectPath)}
     ], options);`
  );
  const run = (packaged: string) =>
    execFileSync(process.execPath, ["--require", probe, fileURLToPath(bootstrap)], {
      cwd: directory,
      env: { ...process.env, DEUS_PACKAGED: packaged, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  expect(run("1")).toBe(fileURLToPath(new URL("../../.deus-dev/deus.db", bootstrap)));
  expect(run("")).toBe(filename);
});

it("refuses a live owner through a symlink and takes over after a crash", async () => {
  const databaseUrl = new URL("../../../src/lib/database.ts", import.meta.url);
  const tsconfig = new URL("../../../tsconfig.json", import.meta.url);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "--eval",
      `const { initDatabase } = await import(${JSON.stringify(databaseUrl.href)});
       initDatabase();
       console.log('OWNER_READY');
       setInterval(() => {}, 1000);`,
    ],
    {
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(tsconfig) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const alias = join(directory, "alias.db");
  vi.stubEnv("DATABASE_PATH", alias);
  try {
    await vi.waitFor(() => expect(stdout, stderr).toContain("OWNER_READY"), { timeout: 5_000 });
    symlinkSync(filename, alias);
    expect((await loadDatabase()).initDatabase).toThrow(
      /Another Deus backend already owns the database/
    );
  } finally {
    child.kill("SIGKILL");
    await exited;
  }

  expect(existsSync(`${filename}.owner`)).toBe(true);
  expect((await loadDatabase()).initDatabase().prepare("SELECT 1").pluck().get()).toBe(1);
});
