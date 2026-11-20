import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRELAUNCH_SCHEMA_MISMATCH } from "../../../shared/schema";
import {
  datedBackupPath,
  moveDatabaseAside,
  OutdatedDatabaseError,
} from "../../../apps/desktop/main/database-recovery";
import { spawnBackend } from "../../../apps/desktop/main/backend-process";

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
  app: { isPackaged: false, getPath: () => process.env.DEUS_USER_DATA_DIR },
}));
vi.mock("../../../apps/desktop/main/deus-cloud-provision", () => ({}));

let directory: string;
let database: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "deus-recovery-"));
  database = join(directory, "chats.db");
  vi.stubEnv("DEUS_USER_DATA_DIR", directory);
  vi.stubEnv("DATABASE_PATH", database);
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
  const options = spawn.mock.lastCall![2];
  vi.stubEnv("DATABASE_PATH", relative(options.cwd, database));
  expect(await failedChild("", PRELAUNCH_SCHEMA_MISMATCH, 1)).toHaveProperty(
    "databasePath",
    database
  );
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
