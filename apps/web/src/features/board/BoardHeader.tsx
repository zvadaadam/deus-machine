import { channelName } from "@shared/boards";
import { GitBranch, Hash } from "lucide-react";
import type { Board } from "@shared/boards";
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

export function BoardHeader({ board }: { board: Board }) {
  const channel = channelName(board.name);
  return (
    <header className="border-border-subtle flex h-11 shrink-0 items-center gap-2 border-b px-3 md:px-4">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <h1 className="text-foreground flex min-w-0 items-center gap-1 text-base font-semibold">
        <Hash aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{channel}</span>
      </h1>
      <span className="text-text-muted shrink-0 text-xs">· Coordinator</span>
      <WorkspaceChip
        id={board.workspace_id}
        name={board.coordinator_name}
        archived={!!board.read_only}
      />
    </header>
  );
}
