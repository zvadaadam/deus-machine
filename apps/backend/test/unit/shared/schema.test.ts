import { describe, expect, it } from "vitest";
import { isExpectedMigrationError } from "@shared/schema";

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
