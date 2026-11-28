import type BetterSqlite3 from "better-sqlite3";
import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

type BetterSqlite3Constructor = new (
  filename: string,
  options?: BetterSqlite3.Options
) => BetterSqlite3.Database;

interface BunSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

type BunSqliteDatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean; create?: boolean; readwrite?: boolean; strict?: boolean }
) => {
  close(): void;
  exec(sql: string): unknown;
  query(sql: string): { all(...params: unknown[]): unknown[] };
  prepare(sql: string): BunSqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
};

/**
 * Bun, in any shape: the packaged deus-runtime executable AND `bun` running
 * backend code directly (the verification CLI). Under Bun, the backend uses
 * `bun:sqlite` rather than Node's `better-sqlite3` native addon (Node-API in
 * 13+), so "am I on Bun" is the whole question. Gating this on DEUS_PACKAGED
 * as well meant every other Bun entry point tried to load the Node addon.
 */
function isBunRuntime(): boolean {
  return Boolean(process.versions.bun);
}

/** Both SQLite engines use the same diagnostics, but Bun can report SQLITE_ERROR only as errno 1. */
export function isMissingSchemaObject(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "SQLITE_ERROR") ||
      ("errno" in error && error.errno === 1)) &&
    /^(?:no such (?:column|table): |table \S+ has no column named )/.test(error.message)
  );
}

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const mod = requireModule("better-sqlite3") as
    | BetterSqlite3Constructor
    | { default?: BetterSqlite3Constructor };
  if (typeof mod === "function") return mod;
  if (typeof mod.default === "function") return mod.default;
  throw new Error("Unable to load better-sqlite3");
}

function loadBunSqlite(): BunSqliteDatabaseConstructor {
  const mod = requireModule("bun:sqlite") as { Database?: BunSqliteDatabaseConstructor };
  if (!mod.Database) {
    throw new Error("Unable to load bun:sqlite");
  }
  return mod.Database;
}

/**
 * Make a Bun statement answer as a better-sqlite3 one:
 * - `get` with no row is `undefined` (Bun says `null`; the backend tests
 *   `=== undefined`);
 * - `run().changes` counts the rows the statement itself changed. Bun counts
 *   the rows its triggers changed as well (an UPDATE of one session reports 2,
 *   its `updated_at` trigger included); better-sqlite3 reports SQLite's
 *   `changes()`, as `changesNow` reads it here.
 * A BLOB stays a `Uint8Array` under Bun (a Buffer under better-sqlite3): the
 * schema has no BLOB column, and a reader of another database's BLOBs (the
 * browser cookie import) takes `Buffer.from(value)`, which both give.
 * `all`, `iterate` and the rest are Bun's own.
 */
function withBetterSqliteStatementShape(
  statement: BunSqliteStatement,
  changesNow: () => number
): BunSqliteStatement {
  const get = statement.get.bind(statement);
  const run = statement.run.bind(statement);
  statement.get = (...params) => get(...params) ?? undefined;
  statement.run = (...params) => {
    const result = run(...params);
    return result.changes > 0 ? { ...result, changes: changesNow() } : result;
  };
  return statement;
}

function withBetterSqliteShape(
  db: InstanceType<BunSqliteDatabaseConstructor>
): BetterSqlite3.Database {
  const candidate = db as InstanceType<BunSqliteDatabaseConstructor> & {
    pragma?: (source: string) => unknown;
  };

  const prepare = candidate.prepare.bind(candidate);
  let changes: BunSqliteStatement | undefined;
  const changesNow = () => {
    changes ??= prepare("SELECT changes() AS changes");
    return (changes.get() as { changes: number }).changes;
  };
  candidate.prepare = (sql: string) => withBetterSqliteStatementShape(prepare(sql), changesNow);

  candidate.pragma = (source: string) => {
    const trimmed = source.trim();
    const sql = trimmed.toUpperCase().startsWith("PRAGMA") ? trimmed : `PRAGMA ${trimmed}`;
    return candidate.query(sql).all();
  };

  return candidate as unknown as BetterSqlite3.Database;
}

export function openSqliteDatabase(
  filename: string,
  options?: BetterSqlite3.Options
): BetterSqlite3.Database {
  if (isBunRuntime()) {
    // deus-runtime is a Bun-compiled executable. Use Bun's built-in SQLite
    // there instead of crossing back into better-sqlite3's Node native addon.
    // `strict` binds `{ id }` to `@id` and refuses a missing named parameter,
    // as better-sqlite3 does; without it Bun binds NULL for both, silently.
    const BunDatabase = loadBunSqlite();
    const bunOptions = options?.readonly
      ? { readonly: true, strict: true }
      : { create: true, readwrite: true, strict: true };
    return withBetterSqliteShape(new BunDatabase(filename, bunOptions));
  }

  const Database = loadBetterSqlite3();
  return new Database(filename, options);
}
