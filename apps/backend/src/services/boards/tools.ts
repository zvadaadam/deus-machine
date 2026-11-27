import { z } from "zod";
import type { HostToolSource } from "@zvada/agent-server/core";
import { OperatorError, refuse, type SessionCaller } from "@zvada/agent-server/operator";
import { boardPostFields, boardReadOnlyReason } from "@shared/boards";
import { tool } from "@shared/host-tool";
import { TitleSchema } from "@shared/title";
import { AppError } from "../../lib/errors";
import * as store from "./store";
import { coordinatorState, pinBoardTools } from "./coordinator";
import { COORDINATOR_GUIDE } from "./guide";
import { theOperator, workspaceArg } from "../assistants/operator";

const boardArg = z
  .string()
  .min(1)
  .optional()
  .describe("Board ID. Omit when this workspace has one board.");
export function boardSource(sessionId: string): HostToolSource | undefined {
  if (!pinBoardTools(sessionId) || coordinatorState(sessionId) !== "ready") return;
  const result = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const tools = [
    tool(
      "create_board",
      "Create a named board in the person's sidebar. This chat receives its messages.",
      { name: TitleSchema },
      async ({ name }) => result(store.createBoard(sessionId, name))
    ),
    tool(
      "post_to_board",
      "Post a channel message, or reply to a root by number.",
      {
        board: boardArg,
        ...boardPostFields.shape,
        workspace: workspaceArg.describe(
          "The workspace this post reports on. Set it when the post is about one workspace: the person opens that workspace from the post."
        ),
      },
      async ({ board, workspace, ...input }, caller: SessionCaller) => {
        const about = workspace && (await theOperator().find(caller, workspace)).workspace.id;
        const id = store.boardForChat(sessionId, board);
        const { post } = store.savePost(id, input, { kind: "bot", aboutWorkspaceId: about });
        return result({ board: id, thread: post.thread_seq ?? post.seq, seq: post.seq });
      }
    ),
    tool(
      "read_board",
      "Read threads by latest activity or messages in one thread. For the next page pass the returned cursor as after.",
      {
        board: boardArg,
        thread: boardPostFields.shape.thread,
        after: z.number().int().nonnegative().optional(),
      },
      async ({ board, thread, after }) => {
        const id = store.boardForChat(sessionId, board);
        const { name } = store.getBoard(id);
        if (thread) {
          const posts = store.readThread(id, thread, after);
          return result({
            board: id,
            name,
            messages: posts.map(({ seq, body, author_kind }) => ({
              seq,
              body,
              author: author_kind,
            })),
            cursor: posts.at(-1)?.seq,
          });
        }
        const roots = store.readThreads(id, after);
        return result({
          board: id,
          name,
          threads: roots.map(({ seq, body, reply_count, last_line }) => ({
            thread: seq,
            body: body.slice(0, 200),
            replies: reply_count,
            last_line,
          })),
          cursor: roots.at(-1)?.last_seq,
        });
      },
      { readOnly: true }
    ),
  ];
  return {
    name: "boards",
    instructions: COORDINATOR_GUIDE,
    tools,
    async call(name, args, caller, signal) {
      const state = caller.sessionId === sessionId ? coordinatorState(sessionId) : undefined;
      if (state !== "ready")
        throw refuse.access(
          state === "archived"
            ? boardReadOnlyReason.archived
            : "This chat does not belong to an active coordinator workspace."
        );
      const selected = tools.find((each) => each.name === name);
      if (!selected) throw refuse.unsupported("Unknown board tool.");
      try {
        const from: SessionCaller = { kind: "session", ...caller, signal };
        const source = name !== "create_board" && store.deliverySource(sessionId, caller.turnId);
        if (source && name === "read_board")
          return await selected.run({ board: source.board, ...args }, from);
        if (source && name === "post_to_board") {
          if (args.board !== undefined && args.board !== source.board && args.thread === undefined)
            throw refuse.unsupported("Name a thread when replying on a different board.");
          return await selected.run({ ...source, ...args }, from);
        }
        return await selected.run(args, from);
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new OperatorError(
            "invalid_input",
            error.issues[0]?.message ?? "Check the board tool arguments."
          );
        if (error instanceof AppError) throw refuse.unsupported(error.message);
        throw error;
      }
    },
  };
}
