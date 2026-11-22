import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import {
  claimCloudRetry,
  claimLocalRetry,
  deleteFailedWorkspace,
} from "../../../src/services/workspace-lifecycle";

let db: Database.Database;
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/project')");
});
afterEach(() => db.close());

describe.each([
  ["local Retry", "worktree", claimLocalRetry],
  ["cloud Retry", "cloud", claimCloudRetry],
  ["local Delete", "worktree", deleteFailedWorkspace],
  ["cloud Delete", "cloud", deleteFailedWorkspace],
] as const)("%s", (_name, kind, operation) => {
  function seed({
    state,
    selected,
    chat,
    computer,
  }: {
    state: string;
    selected?: string;
    chat?: string;
    computer?: string;
  }) {
    db.prepare(
      `INSERT INTO workspaces (id, repository_id, slug, git_branch, kind, state, current_session_id, provider_workspace_id)
      VALUES ('w', 'r', 'work', 'user/work', ?, ?, ?, ?)`
    ).run(kind, state, selected ?? null, computer ?? null);
    if (chat) db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, 'w')").run(chat);
  }

  it("accepts an error row without a selection, chat or computer", () => {
    seed({ state: "error" });
    expect(() => operation("w")).not.toThrow();
  });

  it.each([
    { state: "initializing" },
    { state: "initializing", computer: "vm" },
    { state: "initializing", chat: "s" },
    { state: "initializing", chat: "s", computer: "vm" },
    { state: "initializing", selected: "s" },
    { state: "initializing", selected: "s", computer: "vm" },
    { state: "initializing", selected: "s", chat: "s" },
    { state: "initializing", selected: "s", chat: "s", computer: "vm" },
    { state: "ready" },
    { state: "ready", computer: "vm" },
    { state: "ready", chat: "s" },
    { state: "ready", chat: "s", computer: "vm" },
    { state: "ready", selected: "s" },
    { state: "ready", selected: "s", computer: "vm" },
    { state: "ready", selected: "s", chat: "s" },
    { state: "ready", selected: "s", chat: "s", computer: "vm" },
    { state: "archived" },
    { state: "archived", computer: "vm" },
    { state: "archived", chat: "s" },
    { state: "archived", chat: "s", computer: "vm" },
    { state: "archived", selected: "s" },
    { state: "archived", selected: "s", computer: "vm" },
    { state: "archived", selected: "s", chat: "s" },
    { state: "archived", selected: "s", chat: "s", computer: "vm" },
    { state: "error", computer: "vm" },
    { state: "error", chat: "s" },
    { state: "error", chat: "s", computer: "vm" },
    { state: "error", selected: "s" },
    { state: "error", selected: "s", computer: "vm" },
    { state: "error", selected: "s", chat: "s" },
    { state: "error", selected: "s", chat: "s", computer: "vm" },
  ])("refuses %j", (input) => {
    seed(input);
    expect(() => operation("w")).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});
