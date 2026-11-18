import { describe, expect, it } from "vitest";
import { PRELAUNCH_SCHEMA_RESET_HINT, SCHEMA_SQL } from "@shared/schema";

describe("shared/schema pre-launch policy", () => {
  it("stores the canonical protocol vocabulary, not a deus dialect", () => {
    // The engine's ids and the unified parent column, on both tables.
    expect(SCHEMA_SQL).toContain("agent_harness TEXT NOT NULL DEFAULT 'claude-code'");
    expect(SCHEMA_SQL).not.toContain("parent_tool_use_id");
    expect(SCHEMA_SQL).not.toContain("agent_message_id");
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS compactions");
  });

  it("uses the fresh schema as the source of truth instead of replayed migrations", () => {
    expect(SCHEMA_SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(SCHEMA_SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
  });

  it("has a clear reset hint for stale local development databases", () => {
    expect(PRELAUNCH_SCHEMA_RESET_HINT).toContain("older pre-launch schema");
    expect(PRELAUNCH_SCHEMA_RESET_HINT).toContain("DATABASE_PATH");
  });
});
