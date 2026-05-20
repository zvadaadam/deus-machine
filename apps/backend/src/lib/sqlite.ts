import type BetterSqlite3 from "better-sqlite3";
import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

type BetterSqlite3Constructor = new (
  filename: string,
  options?: BetterSqlite3.Options
) => BetterSqlite3.Database;

type BunSqliteDatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean; create?: boolean; readwrite?: boolean }
) => {
  close(): void;
  exec(sql: string): unknown;
  query(sql: string): { all(...params: unknown[]): unknown[] };
  prepare(sql: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
};

function isBunRuntime(): boolean {
  return process.env.DEUS_RUNTIME === "1" && Boolean(process.versions.bun);
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

function withBetterSqlitePragmaShape(
  db: InstanceType<BunSqliteDatabaseConstructor>
): BetterSqlite3.Database {
  const candidate = db as InstanceType<BunSqliteDatabaseConstructor> & {
    pragma?: (source: string) => unknown;
  };

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
    const BunDatabase = loadBunSqlite();
    const bunOptions = options?.readonly ? { readonly: true } : { create: true, readwrite: true };
    return withBetterSqlitePragmaShape(new BunDatabase(filename, bunOptions));
  }

  const Database = loadBetterSqlite3();
  return new Database(filename, options);
}
