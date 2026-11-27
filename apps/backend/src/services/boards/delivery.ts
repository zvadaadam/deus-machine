import {
  boardReadOnlyReason,
  channelName,
  type BoardPost,
  type BoardPostInput,
  type BoardRow,
} from "@shared/boards";
import { receivedUserTurns } from "../../db";
import { getDatabase } from "../../lib/database";
import { ConflictError } from "../../lib/errors";
import { isSendPending, sendOrQueue } from "../agent/queue";
import { continuedPermissionMode, continuedSettings } from "../agent/turn-settings";
import { requireUnusedTurn } from "../agent/turns";
import { invalidate, onInvalidate } from "../query-engine";
import * as store from "./store";

onInvalidate((resources, ctx) => {
  if (ctx?.sessionIds?.length) {
    if (resources.some((r) => r === "queuedMessages" || r === "session" || r === "sessions")) {
      const boardIds = store.boardsForDeliveryChats(ctx.sessionIds);
      if (boardIds.length) invalidate(["boardChannel", "boardThread"], { boardIds });
    }
  } else if (resources.includes("workspaces") || resources.includes("sessions")) {
    invalidate(["boards", "boardChannel", "boardThread"]);
  }
});

/** Read the exact initial echoes for this page in one query, even across a change of recipient. */
export function withReceipts<T extends BoardPost>(posts: T[]): BoardRow<T>[] {
  const received = receivedUserTurns(
    getDatabase(),
    posts.flatMap((post) =>
      post.author_kind === "person" && post.delivery_session_id
        ? [{ sessionId: post.delivery_session_id, turnId: post.id }]
        : []
    )
  );
  return posts.map((post) => {
    if (post.author_kind !== "person") return post;
    const waiting = post.delivery_session_id && isSendPending(post.delivery_session_id, post.id);
    return {
      ...post,
      delivery: received.has(post.id) ? "delivered" : waiting ? "waiting" : "not_delivered",
    };
  });
}

async function deliver(boardId: string, post: BoardPost, retry = false) {
  const board = store.getBoard(boardId);
  let recipient = post.delivery_session_id;
  try {
    // We record the recipient before every send, so only the last attempted chat can have this post's turn.
    // Refuse a used turn there before a retry can select a replacement.
    if (retry && recipient) requireUnusedTurn(recipient, post.id);
    recipient = null;
    recipient = store.selectAndRecordDeliveryChat(board);
    store.recordDelivery(boardId, post.seq, recipient, null);
    const permissionMode = continuedPermissionMode(recipient);
    if (permissionMode === "plan")
      throw new ConflictError(
        "The coordinator chat is in Plan mode, so it can read but not answer on the board. Turn Plan off there with /plan, send a message in the chat, then choose Send again."
      );
    const root = post.thread_seq && store.getPost(boardId, post.thread_seq);
    const excerpt = root && root.body.replace(/\s+/gu, " ").slice(0, 72).trimEnd();
    const thread = `thread ${post.thread_seq ?? post.seq}${excerpt ? ` “${excerpt}”` : ""}`;
    await sendOrQueue({
      sessionId: recipient,
      turnId: post.id,
      preserveTurnId: true,
      content: `From #${channelName(board.name)} · ${thread}\n\n${post.body}`,
      ...continuedSettings(recipient),
      permissionMode,
    });
  } catch (error) {
    store.recordDelivery(
      boardId,
      post.seq,
      recipient,
      error instanceof Error ? error.message : "The chat could not receive this post."
    );
  }
  invalidate(["boards", "boardChannel", "boardThread"], { boardIds: [boardId] });
  return { seq: post.seq };
}

export function postBoardMessage(boardId: string, postId: string, input: BoardPostInput) {
  const { post, created } = store.savePost(boardId, input, { kind: "person", postId });
  if (created)
    void deliver(boardId, post).catch((error) =>
      console.error("[Boards] Could not record delivery", error)
    );
  return { seq: post.seq };
}

export async function retryBoardMessage(boardId: string, seq: number) {
  const board = store.getBoard(boardId);
  if (board.read_only) throw new ConflictError(boardReadOnlyReason[board.read_only]);
  const post = store.getPost(boardId, seq);
  if (post.author_kind !== "person")
    throw new ConflictError("Only the person’s posts can be sent again.");
  if (withReceipts([post])[0]?.delivery === "not_delivered") return deliver(boardId, post, true);
  return { seq };
}
