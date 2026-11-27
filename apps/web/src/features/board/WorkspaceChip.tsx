import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useWorkspacesByRepo } from "@/features/workspace/api/workspace.queries";
import type { Workspace } from "@/features/workspace/types";
import { useUnreadStore } from "@/features/session/store/unreadStore";
import { workspaceRowStatus } from "@/features/sidebar/lib/status";
import {
  gitLifecycleLabel,
  WorkspaceGitIcon,
  WorkspaceAttention,
} from "@/features/sidebar/ui/WorkspaceGitIcon";
import { GitBranch } from "lucide-react";
import { LabelPill } from "@/components/ui/label-pill";
import { linkToWorkspace } from "@/features/workspace/lib/workspaceAddress";
import { showWorkspace } from "@/features/workspace/lib/openWorkspace";

const BoardWorkspaces = createContext<ReadonlyMap<string, Workspace>>(new Map());

export function BoardWorkspaceProvider({ children }: { children: ReactNode }) {
  const { data } = useWorkspacesByRepo();
  const workspaces = useMemo(
    () => new Map(data?.flatMap((group) => group.workspaces.map((w) => [w.id, w] as const))),
    [data]
  );
  return <BoardWorkspaces.Provider value={workspaces}>{children}</BoardWorkspaces.Provider>;
}

function useWorkspaceMark(id: string | null) {
  const workspaces = useContext(BoardWorkspaces);
  const unread = useUnreadStore((s) => s.unreadSessionIds);
  const workspace = id && workspaces.get(id);
  if (!workspace) return { icon: <GitBranch aria-hidden />, label: undefined };
  const { status, working, attention, description } = workspaceRowStatus(workspace, unread);
  const git = !working && gitLifecycleLabel(workspace);
  const words = git ? (description === "idle" ? git : `${description}, ${git}`) : description;
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  const icon = (
    <span aria-hidden className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <WorkspaceGitIcon workspace={workspace} displayStatus={status} working={working} size={12} />
      {attention && (
        <span className="absolute top-0 right-0 flex">
          <WorkspaceAttention status={status} attention={attention} size="sm" />
        </span>
      )}
    </span>
  );
  return { icon, label };
}

export function BoardWorkspaceRow({
  id,
  name,
  archived,
}: {
  id: string;
  name: string;
  archived: boolean;
}) {
  const { icon, label } = useWorkspaceMark(archived ? null : id);
  return (
    <button
      type="button"
      disabled={archived}
      onClick={() => showWorkspace(id)}
      className="control-interaction flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm pointer-coarse:min-h-11 [&>svg]:size-3.5 [&>svg]:shrink-0"
    >
      {icon}
      <span className="min-w-0 truncate">{name}</span>
      <span className="text-text-muted ml-auto shrink-0 text-xs">
        {archived ? "Archived" : label}
      </span>
    </button>
  );
}

export function WorkspaceChip({
  id,
  name,
  archived,
}: {
  id: string | null;
  name: string;
  archived?: boolean;
}) {
  const { icon, label } = useWorkspaceMark(archived ? null : id);
  const title = label ? `${name}, ${label}` : name;
  const content = (
    <>
      {icon}
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
        aria-label={`Open workspace, ${title}`}
        title={title}
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
