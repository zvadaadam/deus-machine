import { spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import Database from "better-sqlite3";
import { app } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DATABASE_IN_USE,
  DatabaseInUseError,
  resolveDefaultDatabasePath,
} from "../../../shared/runtime";
import { PRELAUNCH_SCHEMA_MISMATCH } from "../../../shared/schema";
import {
  databaseRecoveryMessage,
  datedBackupPath,
  moveDatabaseAside,
  OutdatedDatabaseError,
  startFresh,
} from "../../../apps/desktop/main/database-recovery";
import { spawnBackend } from "../../../apps/desktop/main/backend-process";
import { logMainProcess } from "../../../apps/desktop/main/startup-diagnostics";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync) };
});
vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  spawn,
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => process.env.DEUS_USER_DATA_DIR, relaunch: vi.fn() },
}));
vi.mock("../../../apps/desktop/main/deus-cloud-provision", () => ({}));
vi.mock("../../../apps/desktop/main/startup-diagnostics", () => ({ logMainProcess: vi.fn() }));

let directory: string;
let database: string;
let installedDatabase: string;
const webBackendCwd = resolve(import.meta.dirname, "../../../apps/backend");
beforeEach(() => {
  vi.clearAllMocks();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "deus-recovery-")));
  database = join(directory, "chats.db");
  installedDatabase = resolveDefaultDatabasePath({
    platform: process.platform,
    homeDir: directory,
    xdgDataHome: directory,
  });
  vi.stubEnv("HOME", directory);
  vi.stubEnv("XDG_DATA_HOME", directory);
  vi.stubEnv("DEUS_USER_DATA_DIR", directory);
  vi.stubEnv("DATABASE_PATH", database);
  vi.stubEnv("DEUS_PACKAGED", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function failedChild(stdout: string, stderr: string, code: number) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  spawn.mockReturnValueOnce(child);
  const failure = spawnBackend({ onStdoutLine: vi.fn(), onStderrLine: vi.fn(), onExit: vi.fn() });
  child.stdout.end(stdout);
  // The last diagnostic can be split between writes, even after exit.
  child.stderr.write(stderr.slice(0, 15));
  child.emit("exit", code, null);
  child.stderr.end(stderr.slice(15));
  await once(child.stderr, "end");
  child.emit("close", code, null);
  return failure.catch((error: unknown) => error);
}

function expectWebDatabase(override: string, expected: string) {
  const probe = join(directory, "backend");
  writeFileSync(probe, '#!/bin/sh\nprintf "database=%s\\n" "${DATABASE_PATH-<unset>}"\n', {
    mode: 0o755,
  });
  const result = spawnSync("bun", [resolve(webBackendCwd, "../../scripts/runtime/dev.ts")], {
    env: { ...process.env, NODE_EXECUTABLE: probe, DATABASE_PATH: override },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.stderr).toContain("Backend failed to start"); // The probe exits before Vite starts.
  expect(result.stdout).toContain(`database=${expected}\n`);
}

it("offers recovery only for the failed child's own whole stderr line and uses its database path", async () => {
  const ordinary = "Backend exited before starting (code=1, signal=null)";
  const signal = JSON.stringify([PRELAUNCH_SCHEMA_MISMATCH, database]);
  const mismatch = await failedChild("", signal, 1);
  expect(mismatch).toBeInstanceOf(OutdatedDatabaseError);
  expect(mismatch).toHaveProperty("databasePath", database);
  expect(databaseRecoveryMessage(join(directory, "chats-2026-11-20.db"))).toEqual({
    message: "Deus can't read your saved data",
    detail:
      "An older version saved this data. Start Fresh keeps it in chats-2026-11-20.db and reopens Deus with no projects, workspaces, or chats.",
    buttons: ["Show Logs", "Quit", "Start Fresh"],
  });
  expect(await failedChild(signal + "\n", "database is locked", 1)).toEqual(new Error(ordinary));
  expect(await failedChild("", "some other error: " + signal, 1)).toEqual(new Error(ordinary));
  expect(await failedChild("", signal, 0)).not.toBeInstanceOf(OutdatedDatabaseError);
});

it.each([true, false])(
  "reports contention on the dev database from a legacy shell (installed path: %s)",
  async (installed) => {
    vi.stubEnv("DEUS_PACKAGED", "1");
    vi.stubEnv("NODE_ENV", "production");
    const override = installed ? installedDatabase : database;
    vi.stubEnv("DATABASE_PATH", override);
    expectWebDatabase(override, installed ? "<unset>" : database);
    const selected = installed ? join(directory, "deus.db") : database;
    const error = await failedChild("", JSON.stringify([DATABASE_IN_USE, selected]), 1);
    const env = spawn.mock.lastCall![2].env;
    expect(env.DATABASE_PATH).toBe(installed ? join(directory, "deus.db") : database);
    expect(env.DEUS_PACKAGED).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(error).toEqual(new DatabaseInUseError(env.DATABASE_PATH));
  }
);

it.each(["", " "])(
  "passes a relative override intact and reports contention from the child's directory (padding %j)",
  async (padding) => {
    const override = `${padding}link/../chats.db${padding}`;
    vi.stubEnv("DATABASE_PATH", override);
    expectWebDatabase(override, override);
    const failure = await failedChild("", JSON.stringify([DATABASE_IN_USE, database]), 1);
    const { env } = spawn.mock.lastCall![2];
    expect(env.DATABASE_PATH).toBe(override);
    expect(failure).toEqual(new DatabaseInUseError(database));
  }
);

it.each(["link/..", "filename symlink"])(
  "sets the old database aside and reopens through the same %s",
  async (kind) => {
    const target = join(directory, "other");
    mkdirSync(join(target, "nested"), { recursive: true });
    const physical = join(target, 'old "chats".db');
    const sibling = join(directory, basename(physical));
    writeFileSync(sibling, "other chats");
    const link = join(directory, "link");
    symlinkSync(kind === "link/.." ? join(target, "nested") : physical, link);
    const override = kind === "link/.." ? `${link}/../${basename(physical)}` : link;
    vi.stubEnv("DATABASE_PATH", override);
    expectWebDatabase(override, override);

    const old = new Database(physical);
    old.exec("CREATE TABLE repositories (legacy TEXT NOT NULL)");
    old.close();
    vi.resetModules();
    const backend = await import("../../../apps/backend/src/lib/database");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(backend.initDatabase).toThrow(PRELAUNCH_SCHEMA_MISMATCH);
      const signal = JSON.stringify([PRELAUNCH_SCHEMA_MISMATCH, physical]);
      expect(stderr).toHaveBeenCalledWith(signal);
      const error = await failedChild("", signal, 1);
      if (!(error instanceof OutdatedDatabaseError)) throw error;
      expect(error.databasePath).toBe(physical);
      const { env } = spawn.mock.lastCall![2];
      expect(env.DATABASE_PATH).toBe(override);
      const backup = datedBackupPath(error.databasePath);
      startFresh(error.databasePath, backup, "http://localhost:5173");
      expect(existsSync(physical)).toBe(false);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      const saved = new Database(backup, { readonly: true });
      try {
        expect(
          saved.prepare("SELECT name FROM pragma_table_info('repositories')").pluck().all()
        ).toEqual(["legacy"]);
      } finally {
        saved.close();
      }
      const [runtime, ...flags] = kind === "link/.." ? [process.execPath, "--import=tsx"] : ["bun"];
      const restart = spawnSync(
        runtime,
        [
          ...flags,
          "-e",
          `import { initDatabase, closeDatabase } from "./src/lib/database";
           const count = initDatabase().prepare("SELECT COUNT(*) AS n FROM workspaces").get();
           console.log("workspaces=" + count.n);
           closeDatabase();`,
        ],
        { cwd: webBackendCwd, env, encoding: "utf8", timeout: 10_000 }
      );
      expect(restart.status, restart.stderr).toBe(0);
      expect(restart.stdout).toContain("workspaces=0\n");
      expect(realpathSync.native(override)).toBe(physical);
      expect(existsSync(`${physical}.owner`)).toBe(true);
      expect(existsSync(`${link}.owner`)).toBe(false);
      expect(readFileSync(sibling, "utf8")).toBe("other chats");
    } finally {
      backend.closeDatabase();
      stderr.mockRestore();
    }
  }
);

it("uses the file the child opened even when the alias now names another database", async () => {
  const alias = join(directory, "alias.db");
  const other = join(directory, "other.db");
  writeFileSync(database, "old chats");
  writeFileSync(other, "other chats");
  symlinkSync(database, alias);
  vi.stubEnv("DATABASE_PATH", alias);
  const signal = JSON.stringify([PRELAUNCH_SCHEMA_MISMATCH, realpathSync.native(alias)]);
  unlinkSync(alias);
  symlinkSync(other, alias);
  const error = await failedChild("", signal, 1);
  if (!(error instanceof OutdatedDatabaseError)) throw error;
  const backup = datedBackupPath(error.databasePath);
  startFresh(error.databasePath, backup, "http://localhost:5173");
  expect(readFileSync(backup, "utf8")).toBe("old chats");
  expect(readFileSync(alias, "utf8")).toBe("other chats");
});

it("drops a legacy relative override that names the installed file only from the backend cwd", async () => {
  vi.stubEnv("DEUS_PACKAGED", "1");
  await failedChild("", "", 1);
  const desktopCwd = spawn.mock.lastCall![2].cwd;
  const caller = process.cwd();
  try {
    process.chdir(join(webBackendCwd, "src/lib"));
    const desktopPath = relative(desktopCwd, installedDatabase);
    const webPath = relative(webBackendCwd, installedDatabase);
    expect(resolve(desktopPath)).not.toBe(installedDatabase);
    expect(resolve(webPath)).not.toBe(installedDatabase);
    expectWebDatabase(webPath, "<unset>");
    vi.stubEnv("DATABASE_PATH", desktopPath);
    const mismatch = await failedChild(
      "",
      JSON.stringify([PRELAUNCH_SCHEMA_MISMATCH, join(directory, "deus.db")]),
      1
    );
    const childDatabase = spawn.mock.lastCall![2].env.DATABASE_PATH;
    expect(childDatabase).toBe(join(directory, "deus.db"));
    expect(mismatch).toHaveProperty("databasePath", childDatabase);
  } finally {
    process.chdir(caller);
  }
});

it("uses the selected Electron profile when DATABASE_PATH is empty", async () => {
  vi.stubEnv("DATABASE_PATH", "");
  await failedChild("", "", 1);
  expect(spawn.mock.lastCall![2].env.DATABASE_PATH).toBe(join(directory, "deus.db"));
});

it.each([":memory:", "   "])(
  "keeps SQLite's temporary database %j off disk and offers no file recovery",
  async (name) => {
    vi.stubEnv("DATABASE_PATH", name);
    const failure = await failedChild(
      "",
      JSON.stringify([PRELAUNCH_SCHEMA_MISMATCH, ":memory:"]),
      1
    );
    vi.resetModules();
    expect((await import("../../../apps/backend/src/lib/database")).DB_PATH).toBe(":memory:");
    expect(spawn.mock.lastCall![2].env.DATABASE_PATH).toBe(name);
    expect(failure).not.toBeInstanceOf(OutdatedDatabaseError);
  }
);

it("sets the database aside and tells the developer how to restart the Vite server", () => {
  const url = "http://localhost:5173";
  const backup = datedBackupPath(database);
  writeFileSync(database, "old chats");
  const hint = "Run 'bun run dev' again to open Deus with no projects, workspaces, or chats.";
  expect(databaseRecoveryMessage(backup, url).detail).toContain(
    `${basename(backup)} and quits Deus. ${hint}`
  );
  startFresh(database, backup, url);
  expect(readdirSync(directory)).toEqual([basename(backup)]);
  expect(readFileSync(backup, "utf8")).toBe("old chats");
  expect(logMainProcess).toHaveBeenCalledWith(expect.stringContaining(hint));
  expect(app.relaunch).not.toHaveBeenCalled();
});

it.each([
  { platform: "darwin", options: {} },
  { platform: "linux", options: { execPath: "/fixture/Deus.AppImage" } },
])(
  "relaunches the built renderer on $platform after setting the database aside",
  ({ platform, options }) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: platform });
      vi.stubEnv("APPIMAGE", "/fixture/Deus.AppImage");
      writeFileSync(database, "old chats");
      const backup = datedBackupPath(database);
      startFresh(database, backup);
      expect(readFileSync(backup, "utf8")).toBe("old chats");
      expect(app.relaunch).toHaveBeenCalledExactlyOnceWith(options);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  }
);

it.each([
  { sideFiles: ["-wal", "-shm", "-journal"] },
  { sideFiles: ["-journal"] },
  { sideFiles: [] },
])("moves the database and only its present side files ($sideFiles)", ({ sideFiles }) => {
  const suffixes = ["", ...sideFiles];
  for (const suffix of suffixes) writeFileSync(database + suffix, "original " + suffix);
  const backup = datedBackupPath(database);
  moveDatabaseAside(database, backup);
  expect(readdirSync(directory).sort()).toEqual(suffixes.map((s) => basename(backup) + s).sort());
  for (const suffix of suffixes)
    expect(readFileSync(backup + suffix, "utf8")).toBe("original " + suffix);
});

it("keeps earlier backups and skips a dated name even when only its journal exists", () => {
  const first = datedBackupPath(database);
  writeFileSync(first, "earlier chats");
  const second = datedBackupPath(database);
  writeFileSync(second + "-journal", "earlier journal");
  const third = datedBackupPath(database);
  writeFileSync(database, "current chats");
  moveDatabaseAside(database, third);
  expect(readFileSync(first, "utf8")).toBe("earlier chats");
  expect(readFileSync(second + "-journal", "utf8")).toBe("earlier journal");
  expect(readFileSync(third, "utf8")).toBe("current chats");
  expect(third).toMatch(/chats-\d{4}-\d\d-\d\d-3\.db$/);
});

it("leaves the database intact when the name shown in the dialog is taken before the click", () => {
  writeFileSync(database, "current chats");
  writeFileSync(database + "-wal", "current WAL");
  const backup = datedBackupPath(database);
  writeFileSync(backup, "someone else's backup");
  expect(() => moveDatabaseAside(database, backup)).toThrow("Backup already exists");
  expect(readFileSync(database, "utf8")).toBe("current chats");
  expect(readFileSync(database + "-wal", "utf8")).toBe("current WAL");
  expect(readFileSync(backup, "utf8")).toBe("someone else's backup");
});

it("puts side files back when the last move fails", () => {
  writeFileSync(database, "old chats");
  writeFileSync(database + "-wal", "old WAL");
  const backup = datedBackupPath(database);
  const removeName = vi.mocked(unlinkSync);
  const original = removeName.getMockImplementation()!;
  removeName.mockImplementationOnce(original).mockImplementationOnce(() => {
    throw new Error("Failed to release the live database name");
  });
  expect(() => moveDatabaseAside(database, backup)).toThrow("Failed to release");
  expect(readdirSync(directory).sort()).toEqual(["chats.db", "chats.db-wal"]);
  expect(readFileSync(database, "utf8")).toBe("old chats");
  expect(readFileSync(database + "-wal", "utf8")).toBe("old WAL");
});
