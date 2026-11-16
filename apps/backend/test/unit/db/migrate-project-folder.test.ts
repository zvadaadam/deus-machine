import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRELAUNCH_SCHEMA_RESET_HINT, SCHEMA_SQL } from "@shared/schema";
import {
  makeProjectFolderOptional,
  projectFolderBackupPath,
} from "../../../src/db/migrate-project-folder";

/** The schema as it was before a project's folder became optional. */
const OLD_SCHEMA_SQL = SCHEMA_SQL.replace(
  "root_path TEXT UNIQUE",
  "root_path TEXT NOT NULL UNIQUE"
);

let dir: string;
let dbPath: string;

function createOldDatabase(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(OLD_SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order, git_origin_url, updated_at)
    VALUES
      ('repo-a', 'alpha', '/Users/me/alpha', 'main', 0, 'https://github.com/me/alpha.git', '2026-01-01 10:00:00'),
      ('repo-b', 'beta', '/Users/me/beta', 'develop', 1, NULL, '2026-02-02 11:00:00'),
      ('repo-c', 'it''s', '/Users/me/it''s here', 'trunk', 2, 'git@github.com:me/c.git', '2026-03-03 12:00:00');
    INSERT INTO workspaces (id, repository_id, slug, kind, state) VALUES
      ('ws-1', 'repo-a', 'one', 'worktree', 'ready'),
      ('ws-2', 'repo-a', 'two', 'cloud', 'ready'),
      ('ws-3', 'repo-c', 'three', 'worktree', 'error');
    INSERT INTO sessions (id, workspace_id) VALUES ('s-1', 'ws-1'), ('s-2', 'ws-2');
    INSERT INTO messages (id, session_id, role) VALUES ('m-1', 's-1', 'user'), ('m-2', 's-2', 'user');
    INSERT INTO parts (id, session_id, message_id, seq, type, data)
      VALUES ('p-1', 's-1', 'm-1', 0, 'text', '{"text":"keep me"}');
    INSERT INTO automations (id, name, prompt, repository_id, environment)
      VALUES ('auto-1', 'nightly', 'do it', 'repo-b', 'repo-beta');
  `);
  return db;
}

function dump(db: Database.Database) {
  const tables = [
    "repositories",
    "workspaces",
    "sessions",
    "messages",
    "parts",
    "automations",
  ] as const;
  return Object.fromEntries(
    tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()])
  );
}

function schemaObjects(db: Database.Database) {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
}

function rootPathNotNull(db: Database.Database): number {
  const cols = db.pragma("table_info(repositories)") as { name: string; notnull: number }[];
  return cols.find((c) => c.name === "root_path")!.notnull;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-project-folder-"));
  dbPath = path.join(dir, "deus.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("making a project's folder optional", () => {
  it("the old schema fixture really is the old shape", () => {
    expect(OLD_SCHEMA_SQL).not.toBe(SCHEMA_SQL);
    const db = createOldDatabase();
    expect(rootPathNotNull(db)).toBe(1);
    db.close();
  });

  it("keeps every row, id and reference, and makes the column nullable", () => {
    const db = createOldDatabase();
    const before = dump(db);
    const objectsBefore = schemaObjects(db).filter((o) => o.tbl_name === "repositories");

    expect(makeProjectFolderOptional(db, dbPath)).toBe(true);

    expect(dump(db)).toEqual(before);
    expect(rootPathNotNull(db)).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

    // Workspaces still resolve their project.
    const joined = db
      .prepare(
        "SELECT w.id, r.name FROM workspaces w JOIN repositories r ON r.id = w.repository_id ORDER BY w.id"
      )
      .all();
    expect(joined).toEqual([
      { id: "ws-1", name: "alpha" },
      { id: "ws-2", name: "alpha" },
      { id: "ws-3", name: "it's" },
    ]);

    // The table's index (UNIQUE) and trigger exist again, with the same names.
    const objectsAfter = schemaObjects(db).filter((o) => o.tbl_name === "repositories");
    expect(objectsAfter.map((o) => `${o.type}:${o.name}`).sort()).toEqual(
      objectsBefore.map((o) => `${o.type}:${o.name}`).sort()
    );
    expect(objectsAfter.map((o) => o.name)).toContain("update_repositories_updated_at");
    expect(objectsAfter.map((o) => o.name)).toContain("sqlite_autoindex_repositories_1");
    expect(schemaObjects(db).some((o) => o.name === "repositories_rebuild")).toBe(false);
    // Every index and trigger the fresh schema defines exists.
    const fresh = new Database(":memory:");
    fresh.exec(SCHEMA_SQL);
    const names = (d: Database.Database) =>
      schemaObjects(d)
        .filter((o) => o.type === "index" || o.type === "trigger")
        .map((o) => o.name)
        .sort();
    expect(names(db)).toEqual(names(fresh));
    // The table is now the fresh schema's table.
    const tableSql = (d: Database.Database) =>
      (schemaObjects(d).find((o) => o.type === "table" && o.name === "repositories")!.sql ?? "")
        .replace(/\s+/g, " ")
        .replace(/"repositories"|repositories_rebuild/, "repositories")
        .replace("IF NOT EXISTS ", "");
    expect(tableSql(db)).toBe(tableSql(fresh));
    fresh.close();

    // The trigger works.
    db.prepare("UPDATE repositories SET name = 'alpha2' WHERE id = 'repo-a'").run();
    const updated = db.prepare("SELECT updated_at FROM repositories WHERE id = 'repo-a'").get() as {
      updated_at: string;
    };
    expect(updated.updated_at).not.toBe("2026-01-01 10:00:00");

    // Projects without a folder are allowed, several of them; folders stay unique.
    db.exec(`INSERT INTO repositories (id, name, git_origin_url) VALUES
      ('repo-x', 'x', 'https://github.com/me/x'), ('repo-y', 'y', 'https://github.com/me/y')`);
    expect(() =>
      db.exec(
        `INSERT INTO repositories (id, name, root_path) VALUES ('dup', 'dup', '/Users/me/alpha')`
      )
    ).toThrow(/UNIQUE/);

    // Foreign keys are enforced again, and still cascade.
    expect(() =>
      db.exec(`INSERT INTO workspaces (id, repository_id, slug) VALUES ('bad', 'nope', 'bad')`)
    ).toThrow(/FOREIGN KEY/);
    db.exec("DELETE FROM repositories WHERE id = 'repo-c'");
    expect(db.prepare("SELECT id FROM workspaces WHERE id = 'ws-3'").get()).toBeUndefined();
    db.close();
  });

  it("writes a copy of the database first, holding everything as it was", () => {
    const db = createOldDatabase();
    const before = dump(db);
    makeProjectFolderOptional(db, dbPath);
    db.close();

    const backup = projectFolderBackupPath(dbPath);
    expect(backup).toBe(`${dbPath}.before-optional-project-folder.bak`);
    expect(fs.existsSync(backup)).toBe(true);
    const copy = new Database(backup, { readonly: true });
    expect(dump(copy)).toEqual(before);
    expect(rootPathNotNull(copy)).toBe(1);
    copy.close();
  });

  it("never takes a copy cut short for the copy", () => {
    const db = createOldDatabase();
    const before = dump(db);
    const backup = projectFolderBackupPath(dbPath);
    // An earlier attempt was killed while writing: its partial file is still there.
    fs.writeFileSync(`${backup}.partial`, "half a database");
    makeProjectFolderOptional(db, dbPath);
    db.close();

    expect(fs.existsSync(`${backup}.partial`)).toBe(false);
    const copy = new Database(backup, { readonly: true });
    expect(dump(copy)).toEqual(before);
    copy.close();
  });

  it("writes the copy under another name and renames it into place when whole", () => {
    const db = createOldDatabase();
    const backup = projectFolderBackupPath(dbPath);
    const exec = db.exec.bind(db);
    const written: string[] = [];
    vi.spyOn(db, "exec").mockImplementation((sql: string) => {
      if (sql.startsWith("VACUUM INTO")) {
        written.push(sql);
        // The copy is not where the next start looks while it is being written.
        expect(fs.existsSync(backup)).toBe(false);
      }
      return exec(sql);
    });
    makeProjectFolderOptional(db, dbPath);
    db.close();
    expect(written).toEqual([`VACUUM INTO '${backup}.partial'`]);
    expect(fs.existsSync(backup)).toBe(true);
  });

  it("does nothing on a second start", () => {
    const db = createOldDatabase();
    expect(makeProjectFolderOptional(db, dbPath)).toBe(true);
    const backup = projectFolderBackupPath(dbPath);
    fs.rmSync(backup);
    const objects = schemaObjects(db);
    const rows = dump(db);

    expect(makeProjectFolderOptional(db, dbPath)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
    expect(schemaObjects(db)).toEqual(objects);
    expect(dump(db)).toEqual(rows);
    db.close();
  });

  it("never runs on a fresh database", () => {
    const db = new Database(dbPath);
    db.exec(SCHEMA_SQL);
    expect(rootPathNotNull(db)).toBe(0);
    expect(makeProjectFolderOptional(db, dbPath)).toBe(false);
    expect(fs.existsSync(projectFolderBackupPath(dbPath))).toBe(false);
    db.close();
  });

  it("rolls back a failure and leaves the database as it was", () => {
    const db = createOldDatabase();
    const objects = schemaObjects(db);
    const rows = dump(db);

    let message = "";
    try {
      makeProjectFolderOptional(db, dbPath, {
        beforeCommit: () => {
          throw new Error("disk went away");
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/disk went away/);
    expect(message).toMatch(/rolled back/);
    expect(message).not.toContain(PRELAUNCH_SCHEMA_RESET_HINT);
    expect(message).not.toMatch(/delet/i);

    expect(schemaObjects(db)).toEqual(objects);
    expect(dump(db)).toEqual(rows);
    expect(rootPathNotNull(db)).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();

    // The same holds for the file on disk, read afresh.
    const reopened = new Database(dbPath);
    expect(schemaObjects(reopened)).toEqual(objects);
    expect(dump(reopened)).toEqual(rows);
    // And the next start can still do it.
    reopened.pragma("foreign_keys = ON");
    expect(makeProjectFolderOptional(reopened, dbPath)).toBe(true);
    expect(dump(reopened)).toEqual(rows);
    reopened.close();
  });

  it("refuses to change anything when a broken reference would result", () => {
    const db = createOldDatabase();
    const rows = dump(db);
    expect(() =>
      makeProjectFolderOptional(db, dbPath, {
        beforeCommit: (d) => d.exec("DELETE FROM repositories WHERE id = 'repo-a'"),
      })
    ).toThrow(/references broke/);
    expect(dump(db)).toEqual(rows);
    expect(rootPathNotNull(db)).toBe(1);
    db.close();
  });

  it("does not run when the copy cannot be made", () => {
    const db = createOldDatabase();
    const objects = schemaObjects(db);
    const missing = path.join(dir, "no-such-folder", "deus.db");
    expect(() => makeProjectFolderOptional(db, missing)).toThrow(/could not be written/);
    expect(schemaObjects(db)).toEqual(objects);
    expect(rootPathNotNull(db)).toBe(1);
    db.close();
  });

  it("refuses a table with columns it does not know, before copying anything", () => {
    const db = createOldDatabase();
    db.exec("ALTER TABLE repositories ADD COLUMN mystery TEXT");
    expect(() => makeProjectFolderOptional(db, dbPath)).toThrow(/mystery/);
    expect(fs.existsSync(projectFolderBackupPath(dbPath))).toBe(false);
    expect(rootPathNotNull(db)).toBe(1);
    db.close();
  });

  it("runs at startup, once", async () => {
    createOldDatabase().close();
    vi.resetModules();
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;
    try {
      const first = await import("../../../src/lib/database");
      const db = first.initDatabase();
      expect(rootPathNotNull(db)).toBe(0);
      expect(fs.existsSync(projectFolderBackupPath(dbPath))).toBe(true);
      expect((db.prepare("SELECT COUNT(*) AS n FROM repositories").get() as { n: number }).n).toBe(
        3
      );
      first.closeDatabase();

      const mtime = fs.statSync(projectFolderBackupPath(dbPath)).mtimeMs;
      vi.resetModules();
      const second = await import("../../../src/lib/database");
      const again = second.initDatabase();
      expect(rootPathNotNull(again)).toBe(0);
      expect(fs.statSync(projectFolderBackupPath(dbPath)).mtimeMs).toBe(mtime);
      second.closeDatabase();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
      vi.resetModules();
    }
  });
});
