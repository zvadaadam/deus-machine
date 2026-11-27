import {
  BOARD_PAGE_SIZE,
  boardReadOnlyReason,
  type Board,
  type BoardDetail,
  type BoardPost,
  type BoardPostInput,
  type BoardThread,
} from "@shared/boards";
import { invalidate } from "../query-engine";
import { uuidv7 } from "@shared/lib/uuid";
import { getDatabase } from "../../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { HAS_OR_WILL_PIN_BOARD_TOOLS } from "./coordinator";

import { awaitingQuestions, questionCandidates } from "./questions";

type BoardFields = Omit<Board, "waiting">;

const boardCandidates = `(SELECT ${questionCandidates("q.board_id = b.id")}) AS candidates`;

function markAwaiting(posts: BoardPost[], awaiting: ReadonlySet<number>) {
  for (const post of posts) {
    if (awaiting.has(post.seq)) post.awaiting = true;
  }
}

const deliveryChatFields =
  "s.title AS delivery_title, s.chat AS delivery_chat, s.agent_harness AS delivery_harness";
const boardFields = `b.id, b.name, b.workspace_id, b.last_seq,
  s.id AS delivery_session_id, ${deliveryChatFields},
  COALESCE(w.title, w.slug) AS coordinator_name,
  CASE WHEN w.state = 'archived' THEN 'archived' END AS read_only`;
const boardTables = `FROM boards b JOIN workspaces w ON w.id = b.workspace_id
  LEFT JOIN sessions s ON s.id = b.delivery_session_id AND NOT s.is_hidden`;
const boardSelect = `SELECT ${boardFields} ${boardTables}`;

export function listBoards(): Board[] {
  return getDatabase()
    .prepare<[], BoardFields & { candidates: string }>(
      `SELECT ${boardFields}, ${boardCandidates} ${boardTables} WHERE w.state != 'archived' ORDER BY b.id`
    )
    .all()
    .map(({ candidates, ...board }) => ({ ...board, waiting: awaitingQuestions(candidates).size }));
}

/** One lookup for all chats whose queues or echoes changed. */
export function boardsForDeliveryChats(sessionIds: string[]) {
  return getDatabase()
    .prepare<[string], { id: string }>(
      "SELECT id FROM boards WHERE delivery_session_id IN (SELECT value FROM json_each(?))"
    )
    .all(JSON.stringify(sessionIds))
    .map((row) => row.id);
}

export function getBoard(id: string): BoardFields {
  const row = getDatabase()
    .prepare<[string], BoardFields>(boardSelect + " WHERE b.id = ?")
    .get(id);
  if (!row) throw new NotFoundError("This board does not exist.");
  return row;
}

/** The board and the distinct subjects of all its posts, including replies outside the current page. */
export function channelPage(id: string, before?: number) {
  const subjects = `(SELECT json_group_object(id, json_object('name', name, 'archived', json(archived)))
    FROM (SELECT w.id, COALESCE(w.title, w.slug) AS name,
            CASE w.state WHEN 'archived' THEN 'true' ELSE 'false' END AS archived
          FROM (SELECT DISTINCT about_workspace_id FROM board_messages
                WHERE board_id = b.id AND about_workspace_id != b.workspace_id) subject
          JOIN workspaces w ON w.id = subject.about_workspace_id
          ORDER BY name COLLATE NOCASE, w.id)) AS workspaces`;
  const row = getDatabase()
    .prepare<
      [string],
      BoardFields & { workspaces: string; candidates: string }
    >(`SELECT ${boardFields}, ${subjects}, ${boardCandidates} ${boardTables} WHERE b.id = ?`)
    .get(id);
  if (!row) return null;
  const { candidates, workspaces, ...fields } = row;
  const awaiting = awaitingQuestions(candidates);
  const board: BoardDetail = {
    ...fields,
    waiting: awaiting.size,
    workspaces: JSON.parse(workspaces),
  };
  const posts = readChannel(id, before).reverse();
  markAwaiting(posts, awaiting);
  return { board, posts };
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
    .prepare<unknown[], { id: string; name: string }>(
      `SELECT b.id, b.name FROM boards b
    JOIN sessions s ON s.workspace_id = b.workspace_id WHERE s.id = ? AND NOT s.is_hidden
    ${explicit === undefined ? "ORDER BY b.name COLLATE NOCASE, b.id" : "AND b.id = ?"}`
    )
    .all(sessionId, ...(explicit === undefined ? [] : [explicit]));
  if (!rows.length)
    throw new NotFoundError(
      explicit ? "This workspace does not coordinate that board." : "Create a board first."
    );
  if (rows.length > 1) {
    const choices = rows.map(({ name, id }) => `${name} (${id})`).join("\n");
    throw new ValidationError(
      `This workspace has several boards. Pass one of these IDs as board.\n${choices}`
    );
  }
  return rows[0]!.id;
}

/** Choose the recipient at delivery. A fresh chat in this workspace will pin the board tools on first use. */
export function selectAndRecordDeliveryChat(board: BoardFields) {
  if (board.read_only) throw new ConflictError(boardReadOnlyReason[board.read_only]);
  const db = getDatabase();
  const chat = db
    .prepare<[string, string | null], { id: string }>(
      `SELECT id FROM sessions WHERE workspace_id = ? AND NOT is_hidden
     AND ${HAS_OR_WILL_PIN_BOARD_TOOLS}
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
  ${deliveryChatFields}, s.is_hidden AS delivery_hidden`;
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
  by: { kind: "bot"; aboutWorkspaceId?: string } | { kind: "person"; postId: string }
) {
  const db = getDatabase();
  const { body, thread } = input;
  const result = db.transaction(() => {
    if (by.kind === "person") {
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
    const recipient = by.kind === "person" ? board.delivery_session_id : null;
    if (thread) rootPost(boardId, thread);
    const seq = board.last_seq + 1;
    db.prepare("UPDATE boards SET last_seq = ? WHERE id = ?").run(seq, boardId);
    db.prepare(
      `INSERT INTO board_messages (id, board_id, seq, thread_seq, author_kind,
      about_workspace_id, body, last_seq, delivery_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      by.kind === "person" ? by.postId : uuidv7(),
      boardId,
      seq,
      thread ?? null,
      by.kind,
      by.kind === "bot" ? (by.aboutWorkspaceId ?? null) : null,
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
  if (result.created && by.kind === "bot")
    invalidate(["boards", "boardChannel", "boardThread"], { boardIds: [boardId] });
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
  const { candidates } = getDatabase()
    .prepare<[string, number, number], { candidates: string }>(
      `SELECT ${questionCandidates("q.board_id = ? AND (q.seq = ? OR q.thread_seq = ?)")}`
    )
    .get(board, thread, thread)!;
  markAwaiting([root, ...replies], awaitingQuestions(candidates));
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

/** The stored destination of this chat turn. Words in a prompt cannot address a board. */
export function deliverySource(sessionId: string, turnId: string) {
  return getDatabase()
    .prepare<[string, string], { board: string; thread: number }>(
      `SELECT board_id AS board,
    COALESCE(thread_seq, seq) AS thread FROM board_messages
    WHERE id = ? AND author_kind = 'person' AND delivery_session_id = ?`
    )
    .get(turnId, sessionId);
}

export function recordDelivery(
  board: string,
  seq: number,
  sessionId: string | null,
  refusal: string | null
) {
  getDatabase()
    .prepare(
      `UPDATE board_messages SET delivery_session_id = ?, delivery_refusal = ?
    WHERE board_id = ? AND seq = ? AND author_kind = 'person' AND (delivery_session_id IS NOT ? OR delivery_refusal IS NOT ?)`
    )
    .run(sessionId, refusal, board, seq, sessionId, refusal);
}
