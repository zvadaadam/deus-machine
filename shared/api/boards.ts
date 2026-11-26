import { z } from "zod";
import {
  boardPostFields,
  type Board,
  type BoardChannelPage,
  type BoardThreadPage,
} from "../boards";
import { live, out, write } from "./op";

const board = z.object({ boardId: z.string().min(1) });
const sequence = z.number().int().positive();
const page = board.extend({ before: sequence.optional() });
export const boards = live({ name: "boards", output: out<Board[]>() });
export const boardChannel = live({
  name: "boardChannel",
  input: page,
  output: out<BoardChannelPage | null>(),
});
export const boardThread = live({
  name: "boardThread",
  input: page.extend({ thread: sequence }),
  output: out<BoardThreadPage>(),
});
export const postBoardMessage = write({
  name: "postBoardMessage",
  input: board.extend({ ...boardPostFields.shape, postId: z.uuid() }),
  output: out<{ seq: number }>(),
});
export const retryBoardMessage = write({
  name: "retryBoardMessage",
  input: board.extend({ seq: sequence }),
  output: out<{ seq: number }>(),
});
