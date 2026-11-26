import { BoardAvatar } from "./BoardAvatar";
import { channelName } from "@shared/boards";
import { GitBranch, Hash } from "lucide-react";
import type { BoardDetail } from "@shared/boards";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { LabelPill } from "@/components/ui/label-pill";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { linkToWorkspace } from "@/features/workspace/lib/workspaceAddress";
import { showWorkspace } from "@/features/workspace/lib/openWorkspace";

export function WorkspaceChip({
  id,
  name,
  archived,
}: {
  id: string | null;
  name: string;
  archived?: boolean;
}) {
  const content = (
    <>
      <GitBranch aria-hidden />
      <span>{name}</span>
    </>
  );
  if (!id || archived)
    return (
      <LabelPill size="sm" title={name}>
        {content}
      </LabelPill>
    );
  return (
    <LabelPill size="sm" asChild>
      <a
        href={linkToWorkspace({ workspaceId: id })}
        aria-label={`Open workspace, ${name}`}
        onClick={(event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          showWorkspace(id);
        }}
      >
        {content}
      </a>
    </LabelPill>
  );
}

function BoardWorkspaces({ workspaces }: Pick<BoardDetail, "workspaces">) {
  const rows = Object.entries(workspaces);
  if (!rows.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="text-text-secondary hover:bg-control-hover shrink-0 rounded-md px-1.5 py-1 text-xs"
        >
          {rows.length} {rows.length === 1 ? "workspace" : "workspaces"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        {rows.map(([id, workspace]) => (
          <DropdownMenuItem
            key={id}
            disabled={workspace.archived}
            onSelect={() => showWorkspace(id)}
          >
            <GitBranch aria-hidden />
            <span className="min-w-0 truncate">{workspace.name}</span>
            {workspace.archived && (
              <span className="text-text-muted ml-auto text-xs">Archived</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BoardHeader({ board }: { board: BoardDetail }) {
  const channel = channelName(board.name);
  return (
    <header className="border-border-subtle grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 border-b px-3 py-1 md:flex md:h-11 md:px-4 md:py-0">
      <SidebarTrigger className="col-start-1 row-start-1 shrink-0 md:hidden" />
      <h1 className="text-foreground col-start-2 row-start-1 flex min-w-0 items-center gap-1 text-base font-semibold">
        <BoardAvatar kind="bot" board={board} className="mr-1 size-6" />
        <Hash aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{channel}</span>
      </h1>
      <div className="col-span-2 col-start-2 row-start-2 mb-1 flex min-w-0 items-center gap-2 md:mb-0">
        <span className="text-text-muted shrink-0 text-xs">
          <span className="hidden md:inline">· </span>
          <strong className="text-foreground font-semibold">Coordinator</strong>
        </span>
        <WorkspaceChip
          id={board.workspace_id}
          name={board.coordinator_name}
          archived={!!board.read_only}
        />
      </div>
      <div className="col-start-3 row-start-1 ml-auto flex shrink-0 items-center">
        <BoardWorkspaces workspaces={board.workspaces} />
      </div>
    </header>
  );
}
