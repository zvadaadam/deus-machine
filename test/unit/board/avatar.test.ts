import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Board, BoardPost } from "@shared/boards";
import { BoardAvatar } from "../../../apps/web/src/features/board/BoardAvatar";

it("derives the coordinator's square mark from the board and gives a person a circle", () => {
  const board: Board = {
    id: "board-1",
    name: "Release desk",
    workspace_id: "mars",
    coordinator_name: "Mobile",
    last_seq: 1,
    delivery_session_id: null,
    read_only: null,
  };
  function avatar(kind: BoardPost["author_kind"], changes: Partial<Board> = {}) {
    return renderToStaticMarkup(
      createElement(BoardAvatar, { kind, board: { ...board, ...changes } })
    );
  }
  const mark = avatar("bot");
  expect(mark).toBe(avatar("bot", { name: "Renamed board", delivery_session_id: "new-chat" }));
  expect(mark).not.toBe(avatar("bot", { id: "another-board" }));
  expect(mark).toContain("rounded-[20%]");
  expect(avatar("person")).toContain("rounded-full");
});
