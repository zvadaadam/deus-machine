import type { Board, BoardRow } from "@shared/boards";
import { useMutation } from "@tanstack/react-query";
import { api } from "@shared/api";
import { getErrorMessage } from "@shared/lib/errors";
import { chatTabLabel } from "@/features/session/ui/tabs/types";
import { openChat } from "@/features/session/lib/openChat";
import { linkToWorkspace } from "@/features/workspace/lib/workspaceAddress";
import { useRuntimeClient } from "@/platform/ws/useRuntimeClient";
import { BoardAvatar } from "./BoardAvatar";

export function BoardReceipt({ board, post }: { board: Board; post: BoardRow }) {
  const runtime = useRuntimeClient();
  const retry = useMutation({
    mutationFn: () => runtime.call(api.retryBoardMessage, { boardId: board.id, seq: post.seq }),
  });
  if (!post.delivery) return null;
  if (post.delivery === "not_delivered")
    return (
      <div role="status" className="text-text-muted mt-1.5 text-xs">
        {post.delivery_refusal
          ? "Not delivered: " + post.delivery_refusal
          : "Not delivered: the coordinator chat didn't get this."}
        {!board.read_only && (
          <button
            type="button"
            className="text-foreground ml-2 underline underline-offset-2"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Send again
          </button>
        )}
        {retry.error && <span role="alert"> {getErrorMessage(retry.error)}</span>}
      </div>
    );
  const chatTitle = chatTabLabel({
    title: post.delivery_title,
    sequence: post.delivery_chat ?? undefined,
    agentHarness: post.delivery_harness ?? "",
  });
  const title = `${post.delivery === "waiting" ? "Queued for" : "Sent to"} Coordinator · ${chatTitle}`;
  const chat = post.delivery_session_id;
  return (
    <div role="status" className="text-text-muted mt-1.5 flex items-center gap-1.5 text-xs">
      <BoardAvatar kind="bot" board={board} className="size-3.5" />
      {chat && !post.delivery_hidden && !board.read_only ? (
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
          {title}
        </a>
      ) : (
        title
      )}
    </div>
  );
}
