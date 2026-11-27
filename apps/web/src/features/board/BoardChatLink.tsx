import type { Board, BoardPost } from "@shared/boards";
import { openChat } from "@/features/session/lib/openChat";
import { chatTabLabel } from "@/features/session/ui/tabs/types";
import { linkToWorkspace } from "@/features/workspace/lib/workspaceAddress";

type Recipient = Pick<
  BoardPost,
  "delivery_session_id" | "delivery_title" | "delivery_chat" | "delivery_harness"
> &
  Partial<Pick<BoardPost, "delivery_hidden">>;

/** The coordinator chat a board or a post delivers to, named as its tab is, opening it while it is open. */
export function BoardChatLink({
  board,
  recipient,
  prefix = "",
}: {
  board: Board;
  recipient: Recipient;
  prefix?: string;
}) {
  const name =
    prefix +
    chatTabLabel({
      title: recipient.delivery_title,
      sequence: recipient.delivery_chat ?? undefined,
      agentHarness: recipient.delivery_harness ?? "",
    });
  const chat = recipient.delivery_session_id;
  if (!chat || recipient.delivery_hidden || board.read_only) return name;
  return (
    <a
      href={linkToWorkspace({ workspaceId: board.workspace_id, sessionId: chat })}
      className="hover:text-foreground hover:underline"
      onClick={(event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
          return;
        event.preventDefault();
        openChat(board.workspace_id, chat);
      }}
    >
      {name}
    </a>
  );
}
