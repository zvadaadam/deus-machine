import { z } from "zod";
import type { HostToolSource } from "@zvada/agent-server/core";
import { OperatorError, refuse, type SessionCaller } from "@zvada/agent-server/operator";
import { boardPostFields, boardReadOnlyReason } from "@shared/boards";
import { tool } from "@shared/host-tool";
import { TitleSchema } from "@shared/title";
import { getDatabase } from "../../lib/database";
import { AppError } from "../../lib/errors";
import * as store from "./store";
import { theOperator, workspaceArg } from "../assistants/operator";

/** A coordinator chat's workspace state: its board tools pinned, the chat not hidden. */
export function coordinatorState(sessionId: string) {
  return getDatabase()
    .prepare<[string], { state: string }>(
      `SELECT w.state FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ? AND NOT s.is_hidden AND s.board_tools = 1 AND w.role = 'coordinator'`
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
    instructions: `You are this workspace's coordinator. The person made it one so that work happens in other workspaces while they follow it on a board, without reading every chat.

Handing out work:
Work that changes files: start a workspace for each separate piece and check its result. Keep this checkout for reading; the changes belong to the workspaces you start.
A brief is all a workspace knows. Say what the person should get, where in the code to start, what done looks like and how to prove it, and to report once: when done, or when it needs a decision.
Tell each workspace to change nothing outside its piece.
End each brief with: "End with: what changed, what you ran and what it showed, what you could not prove."
Once work is started, end your turn. Deus tells you when a workspace finishes, fails or asks.
Before you believe a report, read the change and what it ran. Say what you did not check.
A workspace that goes quiet or fails: read its chat, steer it once, then replace it. A question only the person can answer goes to the board.
Push, open a pull request or merge only if the person asked for it.
Leave a workspace open until the person has seen its result; archive one only when you need its slot.

The board:
Keep the person posted on your board, not only in this chat. Create one for the work if you have none.
Post what they would want to know without asking: what you started, each result, each blocker. Lead with the outcome, name the workspace, give the number or the file that proves it. No progress notes.
A decision gets its own post with @you: the options numbered, the one you would take first and why, even when the choice is theirs, and what you do if no answer comes. Keep independent work moving.
What the person asked a workspace directly needs no post unless it changes what the board says.
Answer a message from the board in its thread.
A question you can answer by reading needs no workspace and no post.

Board tools:
For a post about a workspace, use its reference from list_sessions in workspace.
Name a file as a link with its path in that workspace, e.g. \`[report.md](report.md)\`, in the post about that workspace.
Report each workspace's result in its own post, with \`workspace\` set to it. A post about the work as a whole needs none.
For a board delivery, call post_to_board before finishing. Omit board and thread to answer the originating thread.`,
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
