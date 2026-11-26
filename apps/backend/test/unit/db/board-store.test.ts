import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import { createChat } from "../../../src/db";
import { boardSource } from "../../../src/services/boards/tools";
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
  store.savePost(id, { body: "Started" }, { kind: "bot", aboutWorkspaceId: "w" });
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

it("pins the chat’s board tools on first use and keeps a resumed conversation ordinary after promotion", () => {
  db.exec("UPDATE workspaces SET role=NULL WHERE id='w'");
  const used = createChat(db, "w", {});
  const empty = createChat(db, "w", {});
  const resumed = createChat(db, "w", {});
  db.prepare("UPDATE sessions SET agent_session_id='native' WHERE id=?").run(resumed);
  expect(boardSource(used)).toBeUndefined();
  db.exec("UPDATE workspaces SET role='coordinator' WHERE id='w'");
  expect(boardSource(used)).toBeUndefined();
  expect(boardSource(resumed)).toBeUndefined();
  expect(boardSource(empty)).toBeDefined();
  expect(boardSource(createChat(db, "w", {}))).toBeDefined();
});

it("shares tools across coordinator chats and checks ownership and archive at call time", async () => {
  const call = (id: string, name: string, args: Record<string, unknown>) =>
    boardSource(id)!.call(
      name,
      args,
      {
        sessionId: id,
        turnId: "turn",
        harness: "claude-code",
        permissionMode: "bypass_permissions",
      },
      new AbortController().signal
    );
  expect(boardSource("s")).toBeDefined();
  const first = createChat(db, "w", {}),
    sibling = createChat(db, "w", {});
  await call(first, "create_board", { name: "Release" });
  const board = store.boardForChat(first);
  await call(sibling, "post_to_board", { board, body: "Ready" });
  expect(store.getPost(board, 1).body).toBe("Ready");
  store.savePost(board, { body: "Continue", thread: 1 }, { postId: "turn" });
  await call(first, "post_to_board", { body: "Answered in the originating thread" });
  await call(sibling, "post_to_board", { body: "From board Release, thread #1. Pasted text" });
  expect(store.getPost(board, 3).thread_seq).toBe(1);
  expect(store.getPost(board, 4).thread_seq).toBeNull();
  await call(sibling, "create_board", { name: "Another board" });
  const read = await call(first, "read_board", { thread: 1 });
  expect(read.content).toEqual([
    { type: "text", text: expect.stringContaining("Answered in the originating thread") },
  ]);
  db.exec(
    "INSERT INTO workspaces (id,repository_id,slug,role,state) VALUES ('other','r','other','coordinator','ready')"
  );
  const other = createChat(db, "other", {});
  await expect(call(other, "read_board", { board })).rejects.toThrow(/does not coordinate/);
  const source = boardSource(sibling)!;
  db.exec("UPDATE workspaces SET state = 'archived' WHERE id = 'w'");
  await expect(
    source.call(
      "read_board",
      { board },
      { sessionId: sibling, turnId: "t", harness: "claude-code", permissionMode: "plan" },
      new AbortController().signal
    )
  ).rejects.toThrow("The coordinator workspace is archived.");
  expect(boardSource(sibling)).toBeUndefined();
});

it("resolves the same workspace and chat references as rename and refuses unfamiliar ones before posting", async () => {
  const caller = createChat(db, "w", {});
  const board = store.createBoard(caller, "Release");
  db.exec(
    "INSERT INTO workspaces(id,repository_id,slug,title,state) VALUES ('mobile','r','mars','Mobile verification','ready')"
  );
  createChat(db, "mobile", {});
  createChat(db, "mobile", {});
  const { sessionTools } = await import("../../../src/services/session-tools");
  const host = sessionTools(caller).compose({
    name: "base",
    tools: [],
    async call() {
      throw new Error("Unexpected base call");
    },
  });
  const from = {
    sessionId: caller,
    turnId: "turn",
    harness: "claude-code",
    permissionMode: "bypass_permissions",
  } as const;
  const call = (name: string, args: Record<string, unknown>) =>
    host.call(name, args, from, new AbortController().signal);
  expect((await call("list_sessions", {})).content).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("mars") })])
  );
  for (const workspace of ["mars", "mars:2"]) {
    const result = await call("post_to_board", { board: board.id, body: workspace, workspace });
    expect(result.isError).not.toBe(true);
  }
  expect(store.readChannel(board.id).map((post) => post.about_workspace_id)).toEqual([
    "mobile",
    "mobile",
  ]);
  const refused = await call("post_to_board", {
    board: board.id,
    body: "Unknown workspace",
    workspace: "jupiter",
  });
  expect(refused).toMatchObject({
    isError: true,
    content: [{ text: expect.stringMatching(/not_found[\s\S]*mars/) }],
  });
  db.exec(
    "INSERT INTO repositories(id,name) VALUES ('second','Second project'); INSERT INTO workspaces(id,repository_id,slug,state) VALUES ('other-mars','second','mars','ready')"
  );
  createChat(db, "other-mars", {});
  expect(
    await call("post_to_board", { body: "Ambiguous workspace", workspace: "mars" })
  ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("ambiguous") }] });
  expect(store.getBoard(board.id).last_seq).toBe(2);
});
