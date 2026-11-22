import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import { createLocalWorkspace } from "../../../src/services/workspace-init.service";
import { archiveWorkspace } from "../../../src/services/workspace-archive.service";
import { recordWorkspaceStatus } from "../../../src/services/agent/cloud/driver";

let db: Database.Database;
const { invalidate, start, park } = vi.hoisted(() => ({
  invalidate: vi.fn(),
  start: vi.fn(),
  park: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));
vi.mock("../../../src/services/workspace-checkout", () => ({
  pickWorkspaceName: async () => ({ slug: "work", branchName: "user/work" }),
  initializeWorkspace: start,
}));
vi.mock("../../../src/services/agent/cloud/simulator", async (original) => ({
  ...(await original<typeof import("../../../src/services/agent/cloud/simulator")>()),
  parkCloudSimulator: park,
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

it.each([
  { state: "archived", stage: "running" },
  { state: "ready", stage: "paused" },
])("parks a $state computer before publishing even if parking throws", ({ state, stage }) => {
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, state, init_stage, current_session_id) VALUES ('w', 'r', 'work', ?, 'running', 'chat')"
  ).run(state);
  db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('chat', 'w')");
  park.mockImplementation(() => {
    expect(db.prepare("SELECT state, init_stage FROM workspaces").get()).toEqual({
      state,
      init_stage: stage,
    });
    expect(invalidate).not.toHaveBeenCalled();
    throw new Error("could not park simulator");
  });
  expect(() => recordWorkspaceStatus("w", { status: "paused" })).toThrow(
    "could not park simulator"
  );
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(["workspaces"], {});
});

it("ignores a status report for a missing workspace", () => {
  recordWorkspaceStatus("missing", { status: "paused" });
  expect(park).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
});

it("checks archive admission immediately before writing the row", async () => {
  db.exec(
    "INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'work', 'ready')"
  );
  const state = db.prepare("SELECT state FROM workspaces WHERE id = 'w'").pluck();
  await expect(
    archiveWorkspace("w", () => {
      throw new Error("archive refused");
    })
  ).rejects.toThrow("archive refused");
  expect(state.get()).toBe("ready");
  expect(invalidate).not.toHaveBeenCalled();
  await archiveWorkspace("w", () => expect(state.get()).toBe("ready"));
  expect(state.get()).toBe("archived");
});
