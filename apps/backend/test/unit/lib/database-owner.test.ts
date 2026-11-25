import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
  expect((await loadDatabase()).DB_PATH).toBe(join(directory, "database", "deus.db"));

  vi.resetModules();
  vi.stubEnv("DATABASE_PATH", filename);
  expect((await loadDatabase()).DB_PATH).toBe(filename);
});

it("reuses the same handle within one backend and releases ownership on close", async () => {
  const first = await loadDatabase();
  const db = first.initDatabase();
  try {
    expect(first.initDatabase()).toBe(db);

    vi.resetModules();
    const second = await loadDatabase();
    expect(second.initDatabase).toThrow(/Another Deus backend already owns the database/);
    first.closeDatabase();
    expect(second.initDatabase().prepare("SELECT 1").pluck().get()).toBe(1);
  } finally {
    first.closeDatabase();
  }
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
