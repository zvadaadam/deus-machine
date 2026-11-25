import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDefaultDatabasePath } from "@shared/runtime";
import { tsImport } from "tsx/esm/api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const loadDatabase = () => import("../../../src/lib/database");
const checkoutDatabase = resolve(import.meta.dirname, "../../../../..", ".deus-dev/deus.db");
let directory: string;
let filename: string;

beforeEach(() => {
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "deus-db-owner-")));
  filename = join(directory, "deus.db");
  vi.stubEnv("DEUS_PACKAGED", undefined);
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
  vi.stubEnv("DATABASE_PATH", undefined);
  expect((await loadDatabase()).DB_PATH).toBe(checkoutDatabase);

  vi.resetModules();
  vi.stubEnv("DATABASE_PATH", filename);
  expect((await loadDatabase()).DB_PATH).toBe(filename);
});

it.each(["unset", "installed", "custom"])(
  "opens the raw tsx source with a legacy shell and %s path",
  async (kind) => {
    const installed = resolveDefaultDatabasePath({
      platform: process.platform,
      homeDir: directory,
      xdgDataHome: directory,
    });
    const previousEnv = process.env;
    try {
      process.env = {
        ...previousEnv,
        HOME: directory,
        XDG_DATA_HOME: directory,
        DEUS_PACKAGED: "1",
      };
      if (kind === "unset") delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = kind === "installed" ? installed : filename;
      const { DB_PATH } = await tsImport("../../../src/lib/database.ts", {
        parentURL: import.meta.url,
        tsconfig: resolve(import.meta.dirname, "../../../tsconfig.json"),
      });
      expect(DB_PATH).toBe(kind === "custom" ? filename : checkoutDatabase);
    } finally {
      process.env = previousEnv;
    }
  }
);

it("refuses a live owner through a symlink and takes over after a crash", async () => {
  writeFileSync(filename, "");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const db = require('better-sqlite3')(process.argv[1]);
       db.exec('BEGIN IMMEDIATE');
       process.on('disconnect', () => process.exit());
       process.send('locked');`,
      `${filename}.owner`,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] }
  );
  const exited = once(child, "exit");

  const alias = join(directory, "alias.db");
  vi.stubEnv("DATABASE_PATH", alias);
  try {
    const [message] = await Promise.race([once(child, "message"), exited]);
    expect(message).toBe("locked");
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
