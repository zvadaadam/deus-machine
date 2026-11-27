import * as api from "@shared/api/boards";
import { postBoardMessage, retryBoardMessage, withReceipts } from "../services/boards/delivery";
import * as store from "../services/boards/store";
import { handle } from "./registry";

export default [
  handle(api.boards, store.listBoards),
  handle(api.boardChannel, ({ boardId, before }) => {
    const page = store.channelPage(boardId, before);
    return page && { board: page.board, posts: withReceipts(page.posts) };
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
