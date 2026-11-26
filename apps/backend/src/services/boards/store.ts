import {
  BOARD_PAGE_SIZE,
  boardReadOnlyReason,
  type Board,
  type BoardPost,
  type BoardPostInput,
  type BoardThread,
} from "@shared/boards";
import { invalidate } from "../query-engine";
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";

const boardSelect = `SELECT b.id, b.name, b.workspace_id, b.last_seq,
  CASE WHEN NOT s.is_hidden THEN s.id END AS delivery_session_id,
  COALESCE(w.title, w.slug) AS coordinator_name,
  CASE WHEN w.state = 'archived' THEN 'archived' END AS read_only
  FROM boards b JOIN workspaces w ON w.id = b.workspace_id
  LEFT JOIN sessions s ON s.id = b.delivery_session_id`;

export function listBoards(): Board[] {
  return getDatabase()
    .prepare<[], Board>(boardSelect + " WHERE w.state != 'archived' ORDER BY b.id")
    .all();
}

export function boardDetail(id: string): Board | null {
  return (
    getDatabase()
      .prepare<[string], Board>(boardSelect + " WHERE b.id = ?")
      .get(id) ?? null
  );
}
export function getBoard(id: string): Board {
  const board = boardDetail(id);
  if (!board) throw new NotFoundError("This board does not exist.");
  return board;
}

function writableBoard(id: string) {
  const board = getBoard(id);
  if (board.read_only) throw new ConflictError(boardReadOnlyReason[board.read_only]);
  return board;
}

export function createBoard(sessionId: string, name: string) {
  const id = uuidv7();
  getDatabase()
    .prepare(
      `INSERT INTO boards (id, name, workspace_id, delivery_session_id)
    SELECT ?, ?, workspace_id, id FROM sessions WHERE id = ?`
    )
    .run(id, name, sessionId);
  invalidate(["boards"]);
  return getBoard(id);
}

export function boardForChat(sessionId: string, explicit?: string): string {
  const rows = getDatabase()
    .prepare<unknown[], { id: string }>(
      `SELECT b.id FROM boards b
    JOIN sessions s ON s.workspace_id = b.workspace_id WHERE s.id = ? AND NOT s.is_hidden
    ${explicit === undefined ? "ORDER BY b.id LIMIT 2" : "AND b.id = ?"}`
    )
    .all(sessionId, ...(explicit === undefined ? [] : [explicit]));
  if (!rows.length)
    throw new NotFoundError(
      explicit ? "This workspace does not coordinate that board." : "Create a board first."
    );
  if (rows.length > 1)
    throw new ValidationError("This workspace has several boards. Give the board ID.");
  return rows[0]!.id;
}

/** Choose the recipient at delivery. A fresh chat in this workspace will pin the board tools on first use. */
export function deliveryChat(board: Board) {
  if (board.read_only) throw new ConflictError(boardReadOnlyReason[board.read_only]);
  const db = getDatabase();
  const chat = db
    .prepare<[string, string | null], { id: string }>(
      `SELECT id FROM sessions WHERE workspace_id = ? AND NOT is_hidden
     AND (board_tools = 1 OR (board_tools IS NULL AND agent_session_id IS NULL))
     ORDER BY (id IS ?) DESC, chat DESC LIMIT 1`
    )
    .get(board.workspace_id, board.delivery_session_id);
  if (!chat)
    throw new ConflictError(
      "There is no open coordinator chat in this workspace. Open a new chat, then choose Send again."
    );
  if (chat.id !== board.delivery_session_id) {
    db.prepare("UPDATE boards SET delivery_session_id = ? WHERE id = ?").run(chat.id, board.id);
    invalidate(["boards"]);
  }
  return chat.id;
}

const postFields = `m.id, m.seq, m.thread_seq, m.author_kind, m.about_workspace_id,
  m.body, m.created_at, m.reply_count, m.delivery_session_id, m.delivery_refusal,
  s.title AS delivery_title, s.chat AS delivery_chat, s.agent_harness AS delivery_harness, s.is_hidden AS delivery_hidden`;
const posts = "board_messages m LEFT JOIN sessions s ON s.id = m.delivery_session_id";

export function getPost(board: string, seq: number): BoardPost {
  const post = getDatabase()
    .prepare<
      [string, number],
      BoardPost
    >(`SELECT ${postFields} FROM ${posts} WHERE m.board_id = ? AND m.seq = ?`)
    .get(board, seq);
  if (!post) throw new NotFoundError(`Post #${seq} does not exist on this board.`);
  return post;
}

function rootPost(board: string, seq: number) {
  const root = getPost(board, seq);
  if (root.thread_seq !== null)
    throw new ValidationError(`#${seq} is a reply. Use thread #${root.thread_seq}.`);
  return root;
}

/** The post, its root summary and the board sequence commit together. */
export function savePost(
  boardId: string,
  input: BoardPostInput,
  by: { kind: "bot" } | { postId: string }
) {
  const db = getDatabase();
  const { body, thread } = input;
  const result = db.transaction(() => {
    if ("postId" in by) {
      const existing = db
        .prepare<
          [string],
          { board_id: string; seq: number }
        >("SELECT board_id, seq FROM board_messages WHERE id = ?")
        .get(by.postId);
      if (existing) {
        const post = getPost(existing.board_id, existing.seq);
        if (
          existing.board_id !== boardId ||
          post.author_kind !== "person" ||
          post.body !== body ||
          post.thread_seq !== (thread ?? null)
        )
          throw new ConflictError("This post ID belongs to a different message.");
        return { post, created: false };
      }
    }
    const board = writableBoard(boardId);
    const recipient = "postId" in by ? board.delivery_session_id : null;
    if (thread) rootPost(boardId, thread);
    const seq = board.last_seq + 1;
    db.prepare("UPDATE boards SET last_seq = ? WHERE id = ?").run(seq, boardId);
    db.prepare(
      `INSERT INTO board_messages (id, board_id, seq, thread_seq, author_kind,
      about_workspace_id, body, last_seq, delivery_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "postId" in by ? by.postId : uuidv7(),
      boardId,
      seq,
      thread ?? null,
      "kind" in by ? "bot" : "person",
      "kind" in by ? board.workspace_id : null,
      body,
      thread ? null : seq,
      recipient
    );
    if (thread)
      db.prepare(
        `UPDATE board_messages SET reply_count = reply_count + 1, last_seq = ?
      WHERE board_id = ? AND seq = ?`
      ).run(seq, boardId, thread);
    return { post: getPost(boardId, seq), created: true };
  })();
  if (result.created) invalidate(["boards", "boardChannel", "boardThread"], { boardIds: [boardId] });
  return result;
}

export function readThread(board: string, thread: number, after = 0) {
  rootPost(board, thread);
  return getDatabase()
    .prepare<[string, number, number, number, number], BoardPost>(
      `SELECT ${postFields} FROM ${posts} WHERE m.board_id = ? AND (m.seq = ? OR m.thread_seq = ?)
      AND m.seq > ? ORDER BY m.seq LIMIT ?`
    )
    .all(board, thread, thread, after, BOARD_PAGE_SIZE);
}

/** The window reads the newest replies, then pages back. The agent reads forward from its cursor. */
export function threadPage(board: string, thread: number, before?: number) {
  const root = rootPost(board, thread);
  const replies = getDatabase()
    .prepare<[string, number, number, number], BoardPost>(
      `SELECT ${postFields} FROM ${posts} WHERE m.board_id = ? AND m.thread_seq = ?
     AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`
    )
    .all(board, thread, before ?? Number.MAX_SAFE_INTEGER, BOARD_PAGE_SIZE + 1);
  const hasEarlier = replies.length > BOARD_PAGE_SIZE;
  if (hasEarlier) replies.pop();
  return { root, replies: replies.reverse(), hasEarlier };
}

function roots(board: string, activity: boolean, cursor: number) {
  return getDatabase()
    .prepare<[string, number, number], BoardThread>(
      `SELECT ${postFields}, m.last_seq,
       CASE WHEN m.reply_count THEN last.created_at END AS last_reply_at, substr(last.body, 1, 200) AS last_line
     FROM ${posts} JOIN board_messages last ON last.board_id = m.board_id AND last.seq = m.last_seq
     WHERE m.board_id = ? AND m.thread_seq IS NULL AND ${activity ? "m.last_seq > ? ORDER BY m.last_seq" : "m.seq < ? ORDER BY m.seq DESC"} LIMIT ?`
    )
    .all(board, cursor, BOARD_PAGE_SIZE);
}

export const readChannel = (board: string, before = Number.MAX_SAFE_INTEGER) =>
  roots(board, false, before);
export const readThreads = (board: string, after = 0) => roots(board, true, after);
