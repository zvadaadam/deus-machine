import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import * as store from "../../../src/services/boards/store";

let db: Database.Database;
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`INSERT INTO repositories(id, name) VALUES ('r', 'Project');
    INSERT INTO workspaces(id, repository_id, slug, role, state) VALUES ('w', 'r', 'lead', 'coordinator', 'ready');
    INSERT INTO sessions(id, workspace_id) VALUES ('s', 'w');`);
});
afterEach(() => db.close());

const src = path.resolve(import.meta.dirname, "../../../src");

it("keeps a single writer for both board tables", () => {
  const writes =
    /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+(?:(?:\w+|"[^"]+"|`[^`]+`|\[[^\]]+\])\s*\.\s*)?["`\[]?(?:boards|board_messages)\b/i;
  for (const sql of [
    'INSERT INTO main."boards"',
    "UPDATE OR IGNORE [main].[board_messages]",
    "DELETE FROM `boards`",
  ])
    expect(writes.test(sql)).toBe(true);
  const writers = globSync("**/*.{ts,tsx,js,mjs,cjs,sql}", { cwd: src }).filter((file) =>
    writes.test(readFileSync(path.join(src, file), "utf8"))
  );
  expect(writers).toEqual(["services/boards/store.ts"]);
});

it("keeps the agent service independent of boards", () => {
  const importsBoard = /(?:from\s*|import\s*(?:\(\s*)?|require\(\s*)["'][^"']*\/boards(?:\/|["'])/;
  const imports = globSync("services/agent/**/*.{ts,tsx,js,mjs,cjs}", { cwd: src }).filter((file) =>
    importsBoard.test(readFileSync(path.join(src, file), "utf8"))
  );
  expect(imports).toEqual([]);
});

it("defaults workspaces to an ordinary role and refuses unknown roles", () => {
  db.exec(
    "INSERT INTO workspaces(id, repository_id, slug, kind) VALUES ('cloud', 'r', 'hosted', 'cloud')"
  );
  expect(db.prepare("SELECT role FROM workspaces WHERE id = 'cloud'").get()).toEqual({
    role: null,
  });
  expect(() => db.exec("UPDATE workspaces SET role = 'other' WHERE id = 'cloud'")).toThrow(/CHECK/);
});

it("pages roots by sequence and agents by last activity, with atomic root summaries", () => {
  const id = store.createBoard("s", "Release").id;
  const bot = { kind: "bot" } as const;
  const post = (body: string, thread?: number) => store.savePost(id, { body, thread }, bot).post;
  post("Checks");
  for (let i = 0; i < 40; i++) post("Update " + i);
  post("Green", 1);
  store.savePost(id, { body: "Thanks", thread: 1 }, { postId: "p" });
  expect(store.readChannel(id)).toHaveLength(40);
  expect(store.readChannel(id, 2)).toMatchObject([{ seq: 1, reply_count: 2, last_seq: 43 }]);
  expect(store.readThreads(id, 41)).toMatchObject([{ seq: 1, last_line: "Thanks" }]);
  expect(() => post("Nested", 42)).toThrow(/reply/);
  expect(store.getBoard(id).last_seq).toBe(43);
  expect(store.readChannel(id, 2)[0]?.last_reply_at).toBe(store.getPost(id, 43).created_at);
});

it("keeps the board and subject when the chat is archived and selects its newest eligible chat for delivery", () => {
  const { id } = store.createBoard("s", "Release");
  store.savePost(id, { body: "Started" }, { kind: "bot" });
  store.savePost(id, { body: "Which checks?" }, { postId: "p" });
  db.exec(`INSERT INTO sessions(id, workspace_id) VALUES ('next', 'w');
    UPDATE sessions SET is_hidden = 1 WHERE id = 's'`);
  expect(store.getBoard(id)).toMatchObject({ workspace_id: "w", delivery_session_id: null });
  expect(store.boardForChat("next")).toBe(id);
  store.savePost(id, { body: "All green", thread: 1 }, { kind: "bot" });
  expect(store.deliveryChat(store.getBoard(id))).toBe("next");
  expect(store.getBoard(id).delivery_session_id).toBe("next");
  expect(store.getPost(id, 2).delivery_session_id).toBe("s");
  expect(store.savePost(id, { body: "Which checks?" }, { postId: "p" }).created).toBe(false);
  expect(() => store.savePost(id, { body: "Changed" }, { postId: "p" })).toThrow(
    /different message/
  );
  db.exec("DELETE FROM sessions WHERE id = 's'");
  expect(store.getPost(id, 1)).toMatchObject({
    author_kind: "bot",
    about_workspace_id: "w",
  });
  db.exec("UPDATE workspaces SET state = 'archived' WHERE id = 'w'");
  expect(store.listBoards()).toEqual([]);
  expect(store.getBoard(id).read_only).toBe("archived");
  expect(() => store.savePost(id, { body: "Late" }, { postId: "p3" })).toThrow(/archived/);
  db.exec("UPDATE workspaces SET state = 'ready' WHERE id = 'w'");
  expect(store.listBoards().map((board) => board.id)).toEqual([id]);
  db.exec("DELETE FROM repositories");
  expect(() => store.getBoard(id)).toThrow(/does not exist/);
  expect(db.prepare("SELECT count(*) AS n FROM board_messages").get()).toEqual({ n: 0 });
});
