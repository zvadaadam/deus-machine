import type { ReactNode } from "react";
import { boardReadOnlyReason, channelName, type BoardDetail } from "@shared/boards";
import { Glide } from "@/components/ui/glide";
import { BoardAvatar } from "./BoardAvatar";
import { BoardChatLink } from "./BoardChatLink";
import { BoardWorkspaceRow, WorkspaceChip } from "./WorkspaceChip";

const row = "border-border-subtle flex items-center justify-between gap-3 border-t py-2";

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className={row}>
      <dt className="text-text-muted shrink-0">{term}</dt>
      <dd className="flex min-w-0 justify-end text-right font-medium wrap-anywhere">{children}</dd>
    </div>
  );
}

/** The board's details: one content for hovering its name and for opening it. */
export function BoardDetails({ board }: { board: BoardDetail }) {
  const workspaces = Object.entries(board.workspaces);
  return (
    <>
      <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
        <BoardAvatar kind="bot" board={board} className="size-7" />
        <span className="wrap-anywhere"># {channelName(board.name)}</span>
      </h2>
      <dl className="text-sm">
        <Fact term="Coordinator">
          <WorkspaceChip
            id={board.workspace_id}
            name={board.coordinator_name}
            archived={!!board.read_only}
          />
        </Fact>
        {board.read_only ? (
          <div className={row}>
            <dt className="sr-only">Read only</dt>
            <dd className="text-text-secondary">{boardReadOnlyReason[board.read_only]}</dd>
          </div>
        ) : (
          board.delivery_session_id && (
            <Fact term="Your messages go to">
              <BoardChatLink board={board} recipient={board} />
            </Fact>
          )
        )}
        {board.waiting > 0 && (
          <Fact term="Waiting on you">
            {board.waiting} {board.waiting === 1 ? "question" : "questions"}
          </Fact>
        )}
      </dl>
      {workspaces.length > 0 && (
        <div className="border-border-subtle border-t pt-2">
          <h3 className="text-text-muted pb-1 text-xs font-medium">Workspaces</h3>
          <div className="relative isolate -mx-2">
            <Glide rows="button:enabled" className="bg-control-hover rounded-lg" />
            {workspaces.map(([id, workspace]) => (
              <BoardWorkspaceRow key={id} id={id} {...workspace} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
