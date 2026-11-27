import * as api from "@shared/api/boards";
import { postBoardMessage, retryBoardMessage, withReceipts } from "../services/boards/delivery";
import * as store from "../services/boards/store";
import { invalidate, onInvalidate } from "../services/query-engine";
import { handle } from "./registry";

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

export default [
  handle(api.boards, store.listBoards),
  handle(api.boardChannel, ({ boardId, before }) => {
    const board = store.boardDetail(boardId);
    return board && { board, posts: withReceipts(store.readChannel(boardId, before).reverse()) };
  }),
  handle(api.boardThread, ({ boardId, thread, before }) => {
    const page = store.threadPage(boardId, thread, before);
    const [root, ...replies] = withReceipts([page.root, ...page.replies]);
    return { root: root!, replies, hasEarlier: page.hasEarlier };
  }),
  handle(api.postBoardMessage, ({ boardId, postId, ...post }) =>
    postBoardMessage(boardId, postId, post)
  ),
  handle(api.retryBoardMessage, ({ boardId, seq }) => retryBoardMessage(boardId, seq)),
];
