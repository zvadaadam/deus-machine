import { z } from "zod";
import type { HostToolSource } from "@zvada/agent-server/core";
import { OperatorError, refuse } from "@zvada/agent-server/operator";
import { boardPostFields, boardReadOnlyReason } from "@shared/boards";
import { tool } from "@shared/host-tool";
import { TitleSchema } from "@shared/title";
import { getDatabase } from "../../lib/database";
import { AppError } from "../../lib/errors";
import * as store from "./store";

function coordinatorState(sessionId: string) {
  return getDatabase()
    .prepare<[string], { state: string }>(
      `SELECT w.state FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ? AND NOT s.is_hidden AND w.role = 'coordinator'`
    )
    .get(sessionId)?.state;
}

const boardArg = z
  .string()
  .min(1)
  .optional()
  .describe("Board ID. Omit when this workspace has one board.");
export function boardSource(sessionId: string): HostToolSource | undefined {
  const db = getDatabase();
  const read = db.prepare<[string], { board_tools: number | null }>(
    "SELECT board_tools FROM sessions WHERE id = ?"
  );
  let pin = read.get(sessionId)?.board_tools;
  if (pin === null) {
    // A resumed conversation must find the same tools it started with, including chats from older builds.
    db.prepare(
      `UPDATE sessions SET board_tools = (agent_session_id IS NULL AND EXISTS (
      SELECT 1 FROM workspaces WHERE id = sessions.workspace_id AND role = 'coordinator'
    )) WHERE id = ? AND board_tools IS NULL`
    ).run(sessionId);
    pin = read.get(sessionId)?.board_tools;
  }
  if (pin !== 1 || coordinatorState(sessionId) !== "ready") return;
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
      { board: boardArg, ...boardPostFields.shape },
      async ({ board, ...input }) => {
        const id = store.boardForChat(sessionId, board);
        const { post } = store.savePost(id, input, { kind: "bot" });
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
    instructions:
      "Your workspace can coordinate boards. Use create_board, read_board and post_to_board. Write @you when the person needs to act.",
    tools,
    async call(name, args, caller) {
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
        return await selected.run(args);
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
