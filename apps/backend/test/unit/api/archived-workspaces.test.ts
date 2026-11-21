import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import * as api from "@shared/api/workspaces";
import { LOCAL_CALLER, Registry } from "../../../src/api/registry";
import operations from "../../../src/api/workspaces";
import { handleFrame, removeSubs, serveOperations } from "../../../src/services/query-engine";
import { archiveWorkspace } from "../../../src/services/workspace-archive.service";

let db: Database.Database;
const socket = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/ws.service", () => ({
  getConnection: () => ({ ws: socket, deviceId: "phone" }),
}));
vi.mock("../../../src/services/agent", () => ({ answerToolRequest: vi.fn() }));
const registry = new Registry(operations);
const call = (name: string, kind: "read" | "write", input: unknown) =>
  registry.run(name, kind, input, { caller: LOCAL_CALLER });
const archive = () => call("archiveWorkspace", "write", { workspaceId: "w" });
const restore = () => call("updateWorkspace", "write", { workspaceId: "w", state: "ready" });
const read = (id: string) => call("archivedWorkspaces", "read", { repositoryId: id });

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`INSERT INTO repositories (id,name) VALUES ('r','Example'),('other','Other');
    INSERT INTO workspaces (id,repository_id,slug,state,current_session_id) VALUES ('w','r','local','ready','chat');
    INSERT INTO sessions (id,workspace_id) VALUES ('chat','w');`);
  socket.send.mockClear();
  serveOperations(registry);
});
afterEach(() => {
  removeSubs("phone");
  db.close();
});

it("records the person and time, retains both on restore, and replaces both on the next archive", async () => {
  let now = "2026-11-20 11:00:00";
  db.function("datetime", { varargs: true }, () => now);
  const last = () =>
    db.prepare("SELECT archived_at, archived_by FROM workspaces WHERE id='w'").get();
  await archive();
  expect(last()).toEqual({ archived_at: now, archived_by: null });
  await restore();
  expect(last()).toEqual({ archived_at: now, archived_by: null });
  now = "2026-11-21 12:00:00";
  const by = { kind: "session", sessionId: "chat" } as const;
  await archiveWorkspace("w", undefined, by);
  expect(last()).toEqual({ archived_at: now, archived_by: JSON.stringify(by) });
  await restore();
  now = "2026-11-22 13:00:00";
  await registry.run(
    "archiveWorkspace",
    "write",
    { workspaceId: "w" },
    { caller: { ...LOCAL_CALLER, deviceId: "phone" } }
  );
  expect(last()).toEqual({ archived_at: now, archived_by: null });
});

it("keeps the original archive time and actor when a stale device archives again", async () => {
  const by = { kind: "session", sessionId: "chat" } as const;
  await archiveWorkspace("w", undefined, by);
  const before = db
    .prepare("SELECT archived_at, archived_by, updated_at FROM workspaces WHERE id='w'")
    .get();
  handleFrame("phone", { type: "q:subscribe", id: "sidebar", resource: "workspaces" });
  socket.send.mockClear();
  db.function("datetime", { varargs: true }, () => "2099-01-01");
  await archive();
  expect(
    db.prepare("SELECT archived_at, archived_by, updated_at FROM workspaces WHERE id='w'").get()
  ).toEqual(before);
  expect(socket.send).not.toHaveBeenCalled();
});

it("reads one project's archived rows newest first with parsed origins and legacy times", async () => {
  expect(registry.find("archivedWorkspaces")).toBe(api.archivedWorkspaces);
  expect(registry.find("archivedWorkspaces")).toMatchObject({ kind: "read" });
  expect(() =>
    registry.runLive("archivedWorkspaces", { repositoryId: "r" }, { caller: LOCAL_CALLER })
  ).toThrow(/cannot be subscribed/);
  db.exec(`INSERT INTO workspaces (id,repository_id,slug,title,git_branch,kind,organization_id,state,archived_at,updated_at)
    VALUES ('older','r','old','First','topic','cloud','org','archived','2026-10-01','2026-11-10'),
    ('legacy','r','legacy',NULL,NULL,'worktree',NULL,'archived',NULL,'2026-10-02'),
    ('else','other','else',NULL,NULL,'cloud',NULL,'archived',NULL,'2026-11-11');`);
  const by = { kind: "assistant", id: "operator", name: "Helper" };
  db.prepare("UPDATE workspaces SET archived_by=? WHERE id='older'").run(JSON.stringify(by));
  expect(await read("r")).toEqual([
    {
      id: "legacy",
      slug: "legacy",
      title: null,
      git_branch: null,
      kind: "worktree",
      organization_id: null,
      archived_at: "2026-10-02",
      archived_by: null,
    },
    {
      id: "older",
      slug: "old",
      title: "First",
      git_branch: "topic",
      kind: "cloud",
      organization_id: "org",
      archived_at: "2026-10-01",
      archived_by: by,
    },
  ]);
  db.exec("INSERT INTO repositories (id,name) VALUES ('empty','Empty')");
  expect(await read("empty")).toEqual([]);
  await expect(read("missing")).rejects.toMatchObject({
    statusCode: 404,
    message: "Repository not found",
  });
});

it("sends the new archived count in the next sidebar snapshot, including when the last workspace closes", async () => {
  db.exec(`INSERT INTO workspaces (id,repository_id,slug,state,kind) VALUES
  ('one','r','one','archived','cloud'),('two','r','two','archived','worktree');`);
  handleFrame("phone", { type: "q:subscribe", id: "sidebar", resource: "workspaces" });
  const snapshot = (count: number, ids: string[]) => {
    expect(socket.send).toHaveBeenCalledOnce();
    const frame = JSON.parse(socket.send.mock.calls[0][0]);
    expect(frame.type).toBe("q:snapshot");
    const repo = frame.data.find((r: { repo_id: string }) => r.repo_id === "r");
    expect(repo.archived_count).toBe(count);
    expect(repo.workspaces.map((w: { id: string }) => w.id)).toEqual(ids);
    socket.send.mockClear();
  };
  snapshot(2, ["w"]);
  await archive();
  snapshot(3, []);
  await restore();
  snapshot(2, ["w"]);
});
