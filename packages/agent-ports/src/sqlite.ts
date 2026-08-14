// packages/agent-ports/src/sqlite.ts
// Tiny runtime-agnostic SQLite adapter so the Cursor provider works under Bun
// (bun:sqlite), Node 22+ (node:sqlite), or a backend that ships better-sqlite3.
// All access is on local COPIES of Cursor DBs, so a sync driver is fine.

export interface SqliteDb {
  rows(sql: string, ...params: unknown[]): Record<string, unknown>[];
  row(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
  close(): void;
}

type Opener = (path: string) => Promise<SqliteDb>;

// better-sqlite3 before node:sqlite: the Deus backend runs under Node and
// ships better-sqlite3; node:sqlite is still experimental on some Node 22.x.
const openers: Opener[] = [openBunSqlite, openBetterSqlite3, openNodeSqlite];

let cachedOpener: Opener | undefined;

export async function openSqlite(path: string): Promise<SqliteDb> {
  if (cachedOpener) return cachedOpener(path);
  let lastError: unknown;
  for (const opener of openers) {
    try {
      const db = await opener(path);
      cachedOpener = opener;
      return db;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `agent-ports: no usable SQLite driver (bun:sqlite / node:sqlite / better-sqlite3): ${String(lastError)}`
  );
}

async function openBunSqlite(path: string): Promise<SqliteDb> {
  const spec = "bun:sqlite";
  const { Database } = await import(/* @vite-ignore */ spec);
  const db = new Database(path);
  return {
    rows: (sql, ...params) =>
      db.query(sql).all(...(params as never[])) as Record<string, unknown>[],
    row: (sql, ...params) =>
      (db.query(sql).get(...(params as never[])) ?? undefined) as
        | Record<string, unknown>
        | undefined,
    close: () => db.close(),
  };
}

async function openNodeSqlite(path: string): Promise<SqliteDb> {
  const spec = "node:sqlite";
  const { DatabaseSync } = await import(/* @vite-ignore */ spec);
  const db = new DatabaseSync(path);
  return {
    rows: (sql, ...params) =>
      db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    row: (sql, ...params) =>
      (db.prepare(sql).get(...(params as never[])) ?? undefined) as
        | Record<string, unknown>
        | undefined,
    close: () => db.close(),
  };
}

async function openBetterSqlite3(path: string): Promise<SqliteDb> {
  const spec = "better-sqlite3";
  const mod = await import(/* @vite-ignore */ spec);
  const Database = (mod as { default: new (p: string, o?: object) => never }).default;
  const db = new Database(path) as {
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[];
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
  return {
    rows: (sql, ...params) => db.prepare(sql).all(...params),
    row: (sql, ...params) => db.prepare(sql).get(...params) ?? undefined,
    close: () => db.close(),
  };
}
