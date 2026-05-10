import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, SCHEMA_SQL, isExpectedMigrationError } from "@shared/schema";

let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

const { mockGetDatabase } = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({
  getDatabase: mockGetDatabase,
}));

import {
  budgetLimitGoal,
  clearGoalsForTest,
  completeGoal,
  createGoal,
  deleteGoal,
  getActiveGoal,
  getGoal,
  pauseAllActiveGoals,
  resumeGoal,
} from "../../../src/services/goals/goal-store";

describeWithDb("goal-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedSession(db, "sess-1");
    mockGetDatabase.mockReturnValue(db);
  });

  afterEach(() => {
    db?.close();
    vi.clearAllMocks();
  });

  it("persists goals in SQLite and deletes cancelled goals", () => {
    createGoal({
      sessionId: "sess-1",
      objective: "Ship goal mode",
      tokenBudget: 200_000,
      model: "claude-sonnet-4-6",
      thinkingLevel: "HIGH",
      allowQuestions: false,
      now: 100,
    });

    expect(getActiveGoal("sess-1")).toMatchObject({
      objective: "Ship goal mode",
      status: "active",
      tokenBudget: 200_000,
      spentTokens: 0,
      allowQuestions: false,
    });

    const ended = deleteGoal("sess-1", "cancelled");
    expect(ended).toMatchObject({ reason: "cancelled" });
    expect(getActiveGoal("sess-1")).toBeNull();
  });

  it("replaces an existing session goal when a new goal starts", () => {
    createGoal({
      sessionId: "sess-1",
      objective: "First",
      tokenBudget: null,
      model: "claude-sonnet-4-6",
    });
    const firstId = getGoal("sess-1")?.goalId;

    createGoal({
      sessionId: "sess-1",
      objective: "Second",
      tokenBudget: 500,
      model: "gpt-5.5",
    });

    const goal = getGoal("sess-1");
    expect(goal).toMatchObject({ objective: "Second", tokenBudget: 500, model: "gpt-5.5" });
    expect(goal?.goalId).not.toBe(firstId);
  });

  it("pauses active goals on boot and resumes only paused goals", () => {
    createGoal({
      sessionId: "sess-1",
      objective: "Long run",
      tokenBudget: null,
      model: "claude-sonnet-4-6",
    });

    expect(pauseAllActiveGoals()).toBe(1);
    expect(getActiveGoal("sess-1")).toMatchObject({ status: "paused" });

    const resumed = resumeGoal("sess-1");
    expect(resumed).toMatchObject({ status: "active" });
    expect(resumeGoal("sess-1")).toBeNull();
  });

  it("marks complete and budget_limited as terminal statuses without deleting the row", () => {
    createGoal({
      sessionId: "sess-1",
      objective: "Finish",
      tokenBudget: 100,
      model: "claude-sonnet-4-6",
    });

    const budget = budgetLimitGoal("sess-1", {
      ...getActiveGoal("sess-1")!,
      spentTokens: 100,
    });
    expect(budget).toMatchObject({ reason: "budget_limited", status: "budget_limited" });
    expect(getGoal("sess-1")).toMatchObject({ status: "budget_limited" });

    clearGoalsForTest();
    createGoal({
      sessionId: "sess-1",
      objective: "Finish",
      tokenBudget: null,
      model: "claude-sonnet-4-6",
    });
    const complete = completeGoal("sess-1", "Done");
    expect(complete).toMatchObject({ reason: "complete", summary: "Done", status: "complete" });
    expect(getGoal("sess-1")).toMatchObject({ status: "complete" });
  });
});

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (!isExpectedMigrationError(sql, msg)) throw e;
    }
  }
  return db;
}

function seedSession(db: Database.Database, sessionId: string): void {
  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, ?, ?)").run(
    "repo-1",
    "repo",
    "/tmp/repo"
  );
  db.prepare("INSERT INTO workspaces (id, repository_id, slug) VALUES (?, ?, ?)").run(
    "ws-1",
    "repo-1",
    "workspace"
  );
  db.prepare("INSERT INTO sessions (id, workspace_id, agent_harness) VALUES (?, ?, ?)").run(
    sessionId,
    "ws-1",
    "claude"
  );
}
