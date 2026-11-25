import { EventEmitter, once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { app } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATABASE_IN_USE, DatabaseInUseError } from "../../../shared/runtime";
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
beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "deus-recovery-"));
  database = join(directory, "chats.db");
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

it("offers recovery only for the failed child's own whole stderr line and uses its database path", async () => {
  const ordinary = "Backend exited before starting (code=1, signal=null)";
  const mismatch = await failedChild("", PRELAUNCH_SCHEMA_MISMATCH, 1);
  expect(mismatch).toBeInstanceOf(OutdatedDatabaseError);
  expect(mismatch).toHaveProperty("databasePath", database);
  expect(databaseRecoveryMessage(join(directory, "chats-2026-11-20.db"))).toEqual({
    message: "Deus can't read your saved data",
    detail:
      "An older version saved this data. Start Fresh keeps it in chats-2026-11-20.db and reopens Deus with no projects, workspaces, or chats.",
    buttons: ["Show Logs", "Quit", "Start Fresh"],
  });
  expect(await failedChild(PRELAUNCH_SCHEMA_MISMATCH + "\n", "database is locked", 1)).toEqual(
    new Error(ordinary)
  );
  expect(await failedChild("", "some other error: " + PRELAUNCH_SCHEMA_MISMATCH, 1)).toEqual(
    new Error(ordinary)
  );
  expect(await failedChild("", PRELAUNCH_SCHEMA_MISMATCH, 0)).not.toBeInstanceOf(
    OutdatedDatabaseError
  );
});

it("starts dev from a legacy packaged shell with the checkout database and reports ownership contention", async () => {
  vi.stubEnv("DEUS_PACKAGED", "1");
  vi.stubEnv("NODE_ENV", "production");
  const error = await failedChild("", DATABASE_IN_USE, 1);
  const env = spawn.mock.lastCall![2].env;
  expect(env.DATABASE_PATH).toBe(join(directory, "deus.db"));
  expect(env.DEUS_PACKAGED).toBeUndefined();
  expect(env.NODE_ENV).toBeUndefined();
  expect(error).toEqual(new DatabaseInUseError(env.DATABASE_PATH));
});

it.each(["", " "])(
  "resolves a relative database path from the child's working directory (padding %j)",
  async (padding) => {
    await failedChild("", "", 1);
    const path = relative(spawn.mock.lastCall![2].cwd, database);
    vi.stubEnv("DATABASE_PATH", padding + path + padding);
    const mismatch = await failedChild("", PRELAUNCH_SCHEMA_MISMATCH, 1);
    const childDatabase = spawn.mock.lastCall![2].env.DATABASE_PATH;
    expect(childDatabase).toBe(database);
    expect(mismatch).toHaveProperty("databasePath", childDatabase);
  }
);

it("opens and sets aside the same file when the configured path has a symlink followed by '..'", async () => {
  const other = join(directory, "other");
  mkdirSync(join(other, "state"), { recursive: true });
  symlinkSync(join(other, "state"), join(directory, "link"), "dir");
  writeFileSync(join(other, "chats.db"), "other chats");
  writeFileSync(database, "my chats");
  const configured = `${directory}/link/../chats.db`; // join would remove link/..
  expect(readFileSync(configured, "utf8")).toBe("other chats");
  vi.stubEnv("DATABASE_PATH", configured);
  const mismatch = await failedChild("", PRELAUNCH_SCHEMA_MISMATCH, 1);
  if (!(mismatch instanceof OutdatedDatabaseError)) throw mismatch;
  const childDatabase = spawn.mock.lastCall![2].env.DATABASE_PATH;
  expect(childDatabase).toBe(database);
  expect(mismatch.databasePath).toBe(childDatabase);
  const backup = datedBackupPath(mismatch.databasePath);
  moveDatabaseAside(mismatch.databasePath, backup);
  expect(readFileSync(backup, "utf8")).toBe("my chats");
  expect(readFileSync(configured, "utf8")).toBe("other chats");
});

it.each([":memory:", "   "])(
  "keeps SQLite's temporary database %j off disk and offers no file recovery",
  async (name) => {
    vi.stubEnv("DATABASE_PATH", name);
    const failure = await failedChild("", PRELAUNCH_SCHEMA_MISMATCH, 1);
    expect(spawn.mock.lastCall![2].env.DATABASE_PATH).toBe(":memory:");
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
