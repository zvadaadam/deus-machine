import { describe, expect, it } from "vitest";
import { MIGRATIONS, isExpectedMigrationError } from "@shared/schema";

describe("shared/schema migration error handling", () => {
  it("allows duplicate-column errors only for ADD COLUMN migrations", () => {
    expect(
      isExpectedMigrationError(
        "ALTER TABLE sessions ADD COLUMN error_category TEXT",
        "duplicate column name: error_category"
      )
    ).toBe(true);

    expect(
      isExpectedMigrationError(
        "ALTER TABLE sessions ADD COLUMN error_category TEXT",
        "no such column: error_category"
      )
    ).toBe(false);
  });

  it("allows missing-source-column errors for RENAME COLUMN migrations", () => {
    expect(
      isExpectedMigrationError(
        "ALTER TABLE sessions RENAME COLUMN agent_type TO agent_harness",
        'no such column: "agent_type"'
      )
    ).toBe(true);
  });

  it("allows missing-column errors for DROP COLUMN migrations", () => {
    expect(
      isExpectedMigrationError("ALTER TABLE sessions DROP COLUMN model", 'no such column: "model"')
    ).toBe(true);
  });

  it("does not swallow unrelated migration failures", () => {
    expect(
      isExpectedMigrationError(
        "CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status)",
        "table workspaces has no column named status"
      )
    ).toBe(false);

    expect(
      isExpectedMigrationError(
        "ALTER TABLE sessions ADD COLUMN error_category TEXT",
        "near TEXT: syntax error"
      )
    ).toBe(false);
  });
});

describe("shared/schema data migrations", () => {
  it("keeps a data migration for persisted legacy Codex SDK harness ids", () => {
    expect(MIGRATIONS).toContain(
      `UPDATE sessions SET agent_harness = 'codex-sdk' WHERE agent_harness = 'codex'`
    );
  });

  it("creates the persisted goals table and status index", () => {
    expect(MIGRATIONS.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS goals"))).toBe(true);
    expect(MIGRATIONS).toContain(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
  });
});
