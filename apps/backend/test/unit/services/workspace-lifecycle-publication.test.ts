import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import { createLocalWorkspace } from "../../../src/services/workspace-init.service";
import { archiveWorkspace } from "../../../src/services/workspace-archive.service";

let db: Database.Database;
const { invalidate, start } = vi.hoisted(() => ({
  invalidate: vi.fn(),
  start: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));
vi.mock("../../../src/services/workspace-checkout", () => ({
  pickWorkspaceName: async () => ({ slug: "work", branchName: "user/work" }),
  initializeWorkspace: start,
}));
beforeEach(() => {
  vi.resetAllMocks();
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/project')");
});
afterEach(() => db.close());

it("publishes the committed local workspace even when starting its checkout throws", async () => {
  start.mockImplementation(() => {
    expect(db.prepare("SELECT state FROM workspaces").get()).toEqual({ state: "initializing" });
    expect(invalidate).not.toHaveBeenCalled();
    throw new Error("could not launch checkout");
  });
  await expect(createLocalWorkspace({ repository_id: "r" })).rejects.toThrow(
    "could not launch checkout"
  );
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(["workspaces"]);
});

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
