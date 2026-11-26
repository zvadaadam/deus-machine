import * as api from "@shared/api/boards";
import * as store from "../services/boards/store";
import { invalidate, onInvalidate } from "../services/query-engine";
import { handle } from "./registry";

onInvalidate((resources, ctx) => {
  if (!ctx?.sessionIds?.length && (resources.includes("workspaces") || resources.includes("sessions"))) {
    invalidate(["boards", "boardChannel", "boardThread"]);
  }
});

export default [
  handle(api.boards, store.listBoards),
  handle(api.boardChannel, ({ boardId, before }) => {
    const board = store.boardDetail(boardId);
    return board && { board, posts: store.readChannel(boardId, before).reverse() };
  }),
  handle(api.boardThread, ({ boardId, thread, before }) =>
    store.threadPage(boardId, thread, before)
  ),
];
