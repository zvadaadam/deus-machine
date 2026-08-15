import { describe, expect, it } from "vitest";
import {
  PRELAUNCH_REQUIRED_COLUMNS,
  PRELAUNCH_RETIRED_COLUMNS,
  PRELAUNCH_SCHEMA_RESET_HINT,
  SCHEMA_SQL,
} from "@shared/schema";

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

  it("tracks the pre-launch columns that expose known stale local databases", () => {
    expect(PRELAUNCH_REQUIRED_COLUMNS.sessions).toContain("agent_harness");
    expect(PRELAUNCH_REQUIRED_COLUMNS.sessions).toContain("error_category");
    expect(PRELAUNCH_REQUIRED_COLUMNS.workspaces).toContain("status");
    expect(PRELAUNCH_REQUIRED_COLUMNS.messages).toContain("parent_tool_call_id");
    expect(PRELAUNCH_REQUIRED_COLUMNS.messages).toContain("tokens");
    expect(PRELAUNCH_REQUIRED_COLUMNS.messages).toContain("cost");
    expect(PRELAUNCH_REQUIRED_COLUMNS.parts).toContain("parent_tool_call_id");
    expect(PRELAUNCH_REQUIRED_COLUMNS.compactions).toContain("compaction_id");
  });

  it("tracks retired columns the current schema must no longer carry", () => {
    // Messages render from `parts`; `content` was the pre-parts read path.
    expect(PRELAUNCH_RETIRED_COLUMNS.messages).toContain("content");
    expect(SCHEMA_SQL).not.toMatch(/^\s*content TEXT,?\s*$/m);
  });

  it("keeps the required and retired column sets disjoint", () => {
    // A column in both would make every database unbootable in one direction.
    for (const [table, retired] of Object.entries(PRELAUNCH_RETIRED_COLUMNS)) {
      const required =
        PRELAUNCH_REQUIRED_COLUMNS[table as keyof typeof PRELAUNCH_REQUIRED_COLUMNS] ?? [];
      for (const column of retired) {
        expect(required).not.toContain(column);
      }
    }
  });
});
