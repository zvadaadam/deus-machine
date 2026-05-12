import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  execCalls,
  execFailures,
  migrations,
  mockIsExpectedMigrationError,
  originalDatabasePath,
  schemaSql,
} = vi.hoisted(() => {
  const originalDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = "/tmp/deus-database-unit-test.sqlite";

  return {
    execCalls: [] as string[],
    execFailures: [] as Error[],
    migrations: [`ALTER TABLE workspaces ADD COLUMN workspace_kind TEXT`],
    mockIsExpectedMigrationError: vi.fn(() => false),
    originalDatabasePath,
    schemaSql: `CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(workspace_kind)`,
  };
});

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    pragma() {}

    exec(sql: string) {
      execCalls.push(sql);
      const failure = execFailures.shift();
      if (failure) {
        throw failure;
      }
    }

    close() {}
  },
}));

vi.mock("@shared/schema", () => ({
  MIGRATIONS: migrations,
  SCHEMA_SQL: schemaSql,
  isExpectedMigrationError: mockIsExpectedMigrationError,
}));

import { closeDatabase, initDatabase } from "../../../src/lib/database";

describe("database initialization", () => {
  beforeEach(() => {
    execCalls.length = 0;
    execFailures.length = 0;
    mockIsExpectedMigrationError.mockClear();
    mockIsExpectedMigrationError.mockReturnValue(false);
  });

  afterEach(() => {
    closeDatabase();
  });

  afterAll(() => {
    if (originalDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDatabasePath;
    }
  });

  it("runs migrations after schema creation on the normal path", () => {
    initDatabase();

    expect(execCalls).toEqual([schemaSql, migrations[0]]);
  });

  it("retries schema creation after migrations when an existing DB is missing a new column", () => {
    execFailures.push(new Error("no such column: workspace_kind"));

    initDatabase();

    expect(execCalls).toEqual([schemaSql, migrations[0], schemaSql]);
  });

  it("does not run migrations before retrying unrelated schema failures", () => {
    execFailures.push(new Error("near workspace_kind: syntax error"));

    expect(() => initDatabase()).toThrow("near workspace_kind: syntax error");
    expect(execCalls).toEqual([schemaSql]);
  });
});
