import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@shared/api/repos";
import type { OutputOf } from "@shared/api/op";
import { sessionEvents } from "@shared/api/sessions";
import { SCHEMA_SQL } from "@shared/schema";
import { CLOUD_PROJECT_REMOVAL_REASON } from "@shared/types/repository";
import handlers from "../../../src/api/repos";
import { getAllRepositories } from "../../../src/db";
import { groupWorkspacesByRepo } from "../../../src/lib/workspace-grouping";
import { createAgentEventHandler } from "../../../src/services/agent/event-handler";
import { _reset, dropConnection, subscribe } from "../../../src/services/streams";
import { deleteEmptyUnnamedProjects } from "../../../src/services/workspace-lifecycle";
import { operations } from "../../helpers";

let db: Database.Database;
const invalidate = vi.hoisted(() => vi.fn());
let events: ReturnType<typeof createAgentEventHandler>;
const frames: { type: string; id: string; seq: number }[] = [];
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));
vi.mock("../../../src/services/agent/service", () => ({
  liveTurnId: (id: string) => events.liveTurnId(id),
}));
vi.mock("../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: vi.fn(),
}));
vi.mock("../../../src/services/ws.service", () => ({
  getConnection: () => ({ ws: { send: (frame: string) => frames.push(JSON.parse(frame)) } }),
}));

const call = operations(handlers);
const preview = (repoId: string) => call(api.repoRemoval, { repoId });
const remove = (repoId: string, confirmed: OutputOf<typeof api.repoRemoval>) =>
  call(api.removeRepo, { repoId, confirmed });

function finishTurn(sessionId: string) {
  events.handle({
    sessionId,
    seq: 1,
    event: { type: "turn.ended", sessionId, turnId: "turn", stopReason: "end_turn", timestamp: 1 },
  });
}

beforeEach(() => {
  invalidate.mockClear();
  frames.length = 0;
  _reset();
  events = createAgentEventHandler();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
});
afterEach(() => db.close());

it("removes only this project's archived history and local automation links, keeping its files", async ({
  onTestFinished,
}) => {
  const root = mkdtempSync(path.join(tmpdir(), "deus-project-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".deus", "one"), { recursive: true });
  const files = [path.join(root, "project.txt"), path.join(root, ".deus", "one", "work.txt")];
  for (const file of files) writeFileSync(file, "keep");

  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES ('removed', 'Local', ?)").run(
    root
  );
  db.exec(`
    INSERT INTO repositories (id, name) VALUES ('kept', 'Other');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES
      ('one', 'removed', 'one', 'archived'), ('two', 'removed', 'two', 'archived'),
      ('other', 'kept', 'other', 'ready');
    INSERT INTO sessions (id, workspace_id, is_hidden) VALUES
      ('first', 'one', 0), ('second', 'one', 1), ('third', 'two', 0), ('other', 'other', 0);
    INSERT INTO messages (id, session_id, role, turn_id) SELECT id, id, 'user', id FROM sessions;
    INSERT INTO turns (turn_id, session_id, ended_at) SELECT id, id, 1 FROM sessions;
    INSERT INTO parts (id, message_id, session_id, type) SELECT id, id, session_id, 'text' FROM messages;
    INSERT INTO compactions (compaction_id, turn_id, session_id, status)
      SELECT session_id, turn_id, session_id, 'completed' FROM turns;
    INSERT INTO automations (id, name, prompt, environment, repository_id, workspace_id) VALUES
      ('a', 'Daily', 'task', 'env-a', 'removed', 'one'), ('b', 'Weekly', 'task', 'env-b', 'kept', 'other');
    INSERT INTO automation_runs (id, automation_id, provider_session_id, workspace_id, session_id) VALUES
      ('run-a', 'a', 'platform-a', 'one', 'first'), ('run-b', 'b', 'platform-b', 'other', 'other'),
      ('run-c', 'a', 'platform-c', 'two', NULL), ('run-d', 'a', 'platform-d', NULL, 'second');
  `);

  const counts = { archivedWorkspaces: 2, chats: 3, automations: 1 };
  expect(groupWorkspacesByRepo([], getAllRepositories(db))).toContainEqual(
    expect.objectContaining({ repo_id: "removed", removal: "offered" })
  );
  const confirmed = await preview("removed");
  expect(confirmed).toEqual({ rootPath: root, counts });
  await remove("removed", confirmed);

  expect(db.prepare("SELECT id FROM repositories").pluck().all()).toEqual(["kept"]);
  for (const [table, key] of [
    ["workspaces", "id"],
    ["sessions", "id"],
    ["messages", "id"],
    ["turns", "turn_id"],
    ["parts", "id"],
    ["compactions", "compaction_id"],
  ]) {
    expect(db.prepare(`SELECT ${key} FROM ${table}`).pluck().all(), table).toEqual(["other"]);
  }
  for (const file of files) expect(readFileSync(file, "utf8")).toBe("keep");
  expect(
    db.prepare("SELECT id, repository_id, workspace_id FROM automations ORDER BY id").all()
  ).toEqual([
    { id: "a", repository_id: null, workspace_id: null },
    { id: "b", repository_id: "kept", workspace_id: "other" },
  ]);
  expect(
    db
      .prepare(
        "SELECT id, provider_session_id, workspace_id, session_id FROM automation_runs ORDER BY id"
      )
      .all()
  ).toEqual([
    { id: "run-a", provider_session_id: "platform-a", workspace_id: null, session_id: null },
    { id: "run-b", provider_session_id: "platform-b", workspace_id: "other", session_id: "other" },
    { id: "run-c", provider_session_id: "platform-c", workspace_id: null, session_id: null },
    { id: "run-d", provider_session_id: "platform-d", workspace_id: null, session_id: null },
  ]);
  expect(invalidate).toHaveBeenCalledExactlyOnceWith([
    "workspaces",
    "sessions",
    "session",
    "repos",
    "automations",
    "automationRuns",
  ]);
});

it("removes a project with no workspaces or folder, and reports a missing project", async () => {
  db.exec("INSERT INTO repositories (id, name) VALUES ('r', 'remote')");
  expect(groupWorkspacesByRepo([], getAllRepositories(db))[0].removal).toBe("offered");
  const counts = { archivedWorkspaces: 0, chats: 0, automations: 0 };
  const confirmed = await preview("r");
  expect(confirmed).toEqual({ rootPath: null, counts });
  await remove("r", confirmed);
  await expect(preview("r")).rejects.toMatchObject({ statusCode: 404 });
  await expect(remove("r", confirmed)).rejects.toMatchObject({ statusCode: 404 });
});

it.each([
  ["ready", "worktree", "Archive the remaining workspace first."],
  ["ready", "cloud", CLOUD_PROJECT_REMOVAL_REASON],
  ["archived", "cloud", CLOUD_PROJECT_REMOVAL_REASON],
])("rechecks a %s %s workspace added after the dialog opens", async (state, kind, reason) => {
  db.exec("INSERT INTO repositories (id, name) VALUES ('r', 'project')");
  const confirmed = await preview("r");
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, state, kind) VALUES ('w', 'r', 'w', ?, ?)"
  ).run(state, kind);
  expect(groupWorkspacesByRepo([], getAllRepositories(db))[0].removal).toBe(
    state === "archived" ? "cloud" : undefined
  );
  await expect(preview("r")).rejects.toThrow(reason);
  await expect(remove("r", confirmed)).rejects.toThrow(reason);
  expect(db.prepare("SELECT id FROM workspaces").all()).toEqual([{ id: "w" }]);
  expect(invalidate).not.toHaveBeenCalled();
});

it.each([
  [
    "an archived workspace gains a chat",
    "INSERT INTO sessions (id, workspace_id) VALUES ('late', 'w')",
  ],
  [
    "another archived workspace appears",
    "INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('new', 'r', 'new', 'archived')",
  ],
  [
    "an automation links to the project",
    "INSERT INTO automations (id, name, prompt, environment, repository_id) VALUES ('a', 'Daily', 'check', 'env', 'r')",
  ],
  [
    "a folder is attached to the GitHub project",
    "UPDATE repositories SET root_path = '/repos/project' WHERE id = 'r'",
  ],
])("requires confirmation again when %s", async (_when, change) => {
  db.exec(`
    INSERT INTO repositories (id, name, git_origin_url) VALUES ('r', 'project', 'https://github.com/acme/project');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'work', 'archived');
  `);
  const confirmed = await preview("r");
  db.exec(change);
  const changed = await preview("r");
  await expect(remove("r", confirmed)).rejects.toMatchObject({
    statusCode: 409,
    message: "This project changed. Review what will be removed and confirm again.",
  });
  expect(await preview("r")).toEqual(changed);
  expect(invalidate).not.toHaveBeenCalled();
  await remove("r", changed);
  expect(db.prepare("SELECT id FROM repositories").all()).toEqual([]);
});

it.each([
  ["working", "working", false],
  ["waiting for an answer", "needs_response", false],
  ["waiting for plan approval", "needs_plan_response", false],
  ["admitted before its first event", "idle", true],
] as const)(
  "keeps an archived chat that is %s until it settles",
  async (_when, status, admitted) => {
    db.exec(`
    INSERT INTO repositories (id, name) VALUES ('r', 'Project'), ('other', 'Other');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES
      ('w', 'r', 'work', 'archived'), ('other', 'other', 'other', 'ready');
    INSERT INTO sessions (id, workspace_id, is_hidden) VALUES ('s', 'w', 1), ('other', 'other', 0);
  `);
    const confirmed = await preview("r");
    db.prepare("UPDATE sessions SET status = ? WHERE id = 's'").run(status);
    if (admitted) {
      events.beginTurn("s", "turn");
      events.confirmTurn("s", "turn");
    }
    const reason = {
      statusCode: 409,
      message:
        "A chat in an archived workspace is still working. Restore the workspace and stop it, or wait for it to finish.",
    };
    await expect(preview("r")).rejects.toMatchObject(reason);
    await expect(remove("r", confirmed)).rejects.toMatchObject(reason);
    expect(db.prepare("SELECT id FROM sessions WHERE id = 's'").get()).toEqual({ id: "s" });
    expect(invalidate).not.toHaveBeenCalled();

    events.beginTurn("other", "unrelated");
    finishTurn("s");
    expect(await preview("r")).toEqual(confirmed);
    await remove("r", confirmed);
    expect(db.prepare("SELECT id FROM sessions").pluck().all()).toEqual(["other"]);
  }
);

it("resets a reconnecting reader of each deleted chat and keeps another chat's replay", async () => {
  db.exec(`
    INSERT INTO repositories (id, name) VALUES ('r', 'Project'), ('other', 'Other');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES
      ('w', 'r', 'work', 'archived'), ('other', 'other', 'other', 'ready');
    INSERT INTO sessions (id, workspace_id) VALUES ('first', 'w'), ('second', 'w'), ('kept', 'other');
  `);
  const chats = ["first", "second", "kept"];
  for (const sessionId of chats) subscribe("window", sessionId, sessionEvents, { sessionId });
  const cursors = frames.splice(0);
  dropConnection("window");
  for (const sessionId of chats) finishTurn(sessionId);
  await remove("r", await preview("r"));
  for (const { id, seq } of cursors) subscribe("back", id, sessionEvents, { sessionId: id }, seq);
  const received = (id: string) =>
    frames.filter((frame) => frame.id === id).map((frame) => frame.type);
  expect(received("first")).toEqual(["q:reset", "q:subscribed"]);
  expect(received("second")).toEqual(["q:reset", "q:subscribed"]);
  expect(received("kept")).toEqual(["q:event", "q:subscribed"]);
});

it("at startup unlinks automations and deletes only unnamed projects without workspaces", () => {
  db.exec(`
    DROP TRIGGER validate_project_insert;
    INSERT INTO repositories (id, name) VALUES ('blank', ''), ('used', ''), ('empty', 'Named');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'used', 'work', 'archived');
    INSERT INTO automations (id, name, prompt, environment, repository_id)
      SELECT id, 'Check', 'check', 'env', id FROM repositories;
  `);
  db.exec(SCHEMA_SQL);
  deleteEmptyUnnamedProjects();
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(["workspaces", "repos", "automations"]);
  expect(db.prepare("SELECT id FROM repositories ORDER BY id").pluck().all()).toEqual([
    "empty",
    "used",
  ]);
  expect(db.prepare("SELECT id FROM workspaces").pluck().all()).toEqual(["w"]);
  expect(db.prepare("SELECT id, repository_id FROM automations ORDER BY id").all()).toEqual([
    { id: "blank", repository_id: null },
    { id: "empty", repository_id: "empty" },
    { id: "used", repository_id: "used" },
  ]);
});
