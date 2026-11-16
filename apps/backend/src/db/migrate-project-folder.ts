import type Database from "better-sqlite3";
import fs from "fs";
import {
  REPOSITORIES_COLUMNS,
  REPOSITORIES_TRIGGERS_SQL,
  repositoriesTableSql,
} from "@shared/schema";

/** Where the copy taken before the rebuild is written: next to the database. */
export function projectFolderBackupPath(dbPath: string): string {
  return `${dbPath}.before-optional-project-folder.bak`;
}

interface ColumnInfo {
  name: string;
  notnull: number;
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

/**
 * One-time rebuild of `repositories` so a project's folder (`root_path`) may be
 * empty. SQLite cannot drop NOT NULL in place, so this follows its documented
 * procedure: foreign keys off outside the transaction; in one transaction a new
 * table, every row copied, the old one dropped and the new one renamed, the
 * table's triggers made again and the foreign keys checked; foreign keys on.
 *
 * Runs only while the column is still NOT NULL, so a fresh database and a
 * second start do nothing. A copy of the database is written next to it first
 * (once); if it cannot be made, nothing is changed and this throws. A failure
 * inside the transaction rolls back and leaves the database as it was.
 *
 * Returns whether it rebuilt the table. `hooks` exists for tests.
 */
export function makeProjectFolderOptional(
  db: Database.Database,
  dbPath: string,
  hooks: { beforeCommit?: (db: Database.Database) => void } = {}
): boolean {
  const columns = db.pragma("table_info(repositories)") as ColumnInfo[];
  const rootPath = columns.find((c) => c.name === "root_path");
  if (!rootPath || rootPath.notnull === 0) return false;

  const known = new Set<string>(REPOSITORIES_COLUMNS);
  const unknown = columns.map((c) => c.name).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Cannot make project folders optional: the repositories table has columns this build does not know (${unknown.join(", ")}). Nothing was changed.`
    );
  }

  const backup = projectFolderBackupPath(dbPath);
  if (!fs.existsSync(backup)) {
    try {
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot make project folders optional: the copy of the database at ${backup} could not be written (${reason}). Nothing was changed.`
      );
    }
  }

  const copied = columns.map((c) => c.name).join(", ");
  const violations = () =>
    JSON.stringify(
      (db.pragma("foreign_key_check") as ForeignKeyViolation[]).map(
        (v) => `${v.table}:${v.rowid}:${v.parent}:${v.fkid}`
      )
    );

  db.pragma("foreign_keys = OFF");
  try {
    const before = violations();
    db.transaction(() => {
      const rows = (db.prepare("SELECT COUNT(*) AS n FROM repositories").get() as { n: number }).n;
      db.exec("DROP TABLE IF EXISTS repositories_rebuild");
      db.exec(repositoriesTableSql("repositories_rebuild"));
      db.exec(`INSERT INTO repositories_rebuild (${copied}) SELECT ${copied} FROM repositories`);
      const moved = (
        db.prepare("SELECT COUNT(*) AS n FROM repositories_rebuild").get() as { n: number }
      ).n;
      if (moved !== rows) {
        throw new Error(`copied ${moved} of ${rows} projects`);
      }
      db.exec("DROP TABLE repositories");
      db.exec("ALTER TABLE repositories_rebuild RENAME TO repositories");
      db.exec(REPOSITORIES_TRIGGERS_SQL);
      hooks.beforeCommit?.(db);
      const after = violations();
      if (after !== before) {
        throw new Error(`references broke: ${after}`);
      }
    })();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot make project folders optional: ${reason}. The change was rolled back; the database is as it was, and a copy is at ${backup}.`
    );
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return true;
}
