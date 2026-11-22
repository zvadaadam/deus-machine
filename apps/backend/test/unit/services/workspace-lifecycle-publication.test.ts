import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import {
  archiveWorkspace,
  unarchiveWorkspace,
} from "../../../src/services/workspace-archive.service";
import { runWorkspaceAttempt } from "../../../src/services/workspace-lifecycle";

let db: Database.Database;
const { invalidate } = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));
beforeEach(() => {
  vi.resetAllMocks();
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/project')");
});
afterEach(() => db.close());

it("checks archive admission immediately before writing the row", async () => {
  db.exec(
    "INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'work', 'ready')"
  );
  const state = db.prepare("SELECT state FROM workspaces WHERE id = 'w'");
  await expect(
    archiveWorkspace("w", () => {
      throw new Error("archive refused");
    })
  ).rejects.toThrow("archive refused");
  expect(state.get()).toEqual({ state: "ready" });
  expect(invalidate).not.toHaveBeenCalled();
  await archiveWorkspace("w", () => expect(state.get()).toEqual({ state: "ready" }));
  expect(state.get()).toEqual({ state: "archived" });
});

it("publishes a committed archive after checkout cleanup even when the workflow update fails", async () => {
  db.exec(`
    INSERT INTO workspaces (id, repository_id, slug) VALUES ('w', 'r', 'work');
    CREATE TRIGGER fail_workflow BEFORE UPDATE OF status ON workspaces
    BEGIN SELECT RAISE(ABORT, 'workflow failed'); END;
  `);
  const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const attempt = runWorkspaceAttempt("w", (signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return cleanup.promise;
  });
  const archive = expect(archiveWorkspace("w")).rejects.toThrow("workflow failed");
  try {
    await aborted.promise;
    expect(db.prepare("SELECT state FROM workspaces").get()).toEqual({ state: "archived" });
    expect(invalidate).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    await attempt;
    await archive;
  }
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(["workspaces"]);
});

it("publishes a committed restore even when its workflow update fails", async () => {
  db.exec(`
    INSERT INTO workspaces (id, repository_id, slug, state, status, current_session_id)
    VALUES ('w', 'r', 'work', 'archived', 'done', 'chat');
    INSERT INTO sessions (id, workspace_id) VALUES ('chat', 'w');
    CREATE TRIGGER fail_workflow BEFORE UPDATE OF status ON workspaces
    BEGIN SELECT RAISE(ABORT, 'workflow failed'); END;
  `);
  await expect(unarchiveWorkspace("w")).rejects.toThrow("workflow failed");
  expect(db.prepare("SELECT state FROM workspaces").get()).toEqual({ state: "ready" });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(["workspaces", "sessions"]);
});
