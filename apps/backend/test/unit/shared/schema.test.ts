import { describe, expect, it } from "vitest";
import {
  PRELAUNCH_REQUIRED_COLUMNS,
  PRELAUNCH_SCHEMA_RESET_HINT,
  SCHEMA_SQL,
} from "@shared/schema";

describe("shared/schema pre-launch policy", () => {
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
    expect(PRELAUNCH_REQUIRED_COLUMNS.messages).toContain("stop_reason");
    expect(PRELAUNCH_REQUIRED_COLUMNS.parts).toContain("parent_tool_call_id");
  });
});
