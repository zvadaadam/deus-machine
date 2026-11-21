import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import {
  applyCloudStatus,
  attachCloudComputer,
  finishLocalStart,
  insertLocalWorkspace,
  markArchived,
} from "../../../src/services/workspace-lifecycle";

let db: Database.Database;
const { invalidate } = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));

beforeEach(() => {
  invalidate.mockReset();
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("INSERT INTO repositories (id, name) VALUES ('r', 'repo')");
});
afterEach(() => db.close());

const local = {
  id: "w",
  repository_id: "r",
  slug: "work",
  git_branch: "user/work",
  git_source_branch: "main",
  git_target_branch: "main",
  title: null,
  pr_url: null,
  pr_number: null,
  first_session_id: "first",
  started_by: null,
};

it.each([
  {
    operation: "local creation",
    initial: false,
    expected: { state: "initializing" },
    write: (step: () => void) => insertLocalWorkspace(db, local, step),
    notification: [["workspaces"]],
  },
  {
    operation: "opening the first chat",
    initial: true,
    expected: { state: "ready", current_session_id: "first" },
    write: (step: () => void) => finishLocalStart("w", step),
    notification: [["workspaces", "sessions"]],
  },
  {
    operation: "attaching a cloud computer",
    initial: true,
    expected: { provider_workspace_id: "vm", init_stage: "creating cloud session" },
    write: (step: () => void) => attachCloudComputer(db, "w", "vm", 42, step),
    notification: [["workspaces", "sessions", "session"], {}],
  },
  {
    operation: "applying cloud status",
    initial: true,
    expected: { init_stage: "paused" },
    write: (step: () => void) =>
      applyCloudStatus("w", { status: "paused" }, { beforePublish: step }),
    notification: [["workspaces"], {}],
  },
])(
  "publishes the committed row when an effect throws during $operation",
  ({ initial, expected, write, notification }) => {
    if (initial)
      db.exec(
        "INSERT INTO workspaces (id, repository_id, slug, first_session_id) VALUES ('w', 'r', 'work', 'first')"
      );
    const read = () => db.prepare("SELECT * FROM workspaces WHERE id = 'w'").get();
    const error = new Error("intervening effect failed");
    const observed = vi.fn(() => {
      expect(read()).toMatchObject(expected);
      expect(invalidate).not.toHaveBeenCalled();
      throw error;
    });
    expect(() => write(observed)).toThrow(error);
    expect(observed).toHaveBeenCalledOnce();
    expect(invalidate.mock.calls).toEqual([notification]);
    expect(read()).toMatchObject(expected);
  }
);

it("checks archive admission immediately before writing the row", () => {
  db.exec(
    "INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'work', 'ready')"
  );
  const state = db.prepare("SELECT state FROM workspaces WHERE id = 'w'").pluck();
  const refused = new Error("archive refused");
  expect(() =>
    markArchived(db, "w", () => {
      throw refused;
    })
  ).toThrow(refused);
  expect(state.get()).toBe("ready");

  markArchived(db, "w", () => expect(state.get()).toBe("ready"));
  expect(state.get()).toBe("archived");
  expect(invalidate).not.toHaveBeenCalled();
});
