import { useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import type { ReportedOrigin } from "@shared/protocol-types";
import type { RepoGroup, Workspace } from "@shared/types/workspace";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { OriginCaption } from "@/features/session/ui/SentFrom";
import { useUnarchiveWorkspace } from "@/features/workspace/api/workspace.queries";
import { getRuntimeClient } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import { cn } from "@/shared/lib/utils";
import { SidebarRow, SidebarRowMain, SidebarRowIconSlot } from "./SidebarRow";

type ArchivedWorkspace = Pick<
  Workspace,
  "id" | "slug" | "title" | "git_branch" | "kind" | "organization_id"
> & {
  archived_at: string;
  archived_by: ReportedOrigin | null;
};

export function ArchivedWorkspaces({
  repository,
  inPlace,
}: {
  repository: RepoGroup & { archived_count?: number };
  inPlace: (w: ArchivedWorkspace) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { repo_id: repositoryId, archived_count: count } = repository;
  const archives = useQuery({
    queryKey: queryKeys.workspaces.archived(repositoryId, count),
    // Replace this request with call(api.archivedWorkspaces, { repositoryId }) when the shared declaration lands.
    queryFn: () =>
      getRuntimeClient().sendRequest<ArchivedWorkspace[]>("archivedWorkspaces", { repositoryId }),
    enabled: open && count !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
  if (count === undefined || (!open && !count)) return null;
  const rows = archives.isError ? undefined : archives.data?.filter(inPlace);
  return (
    <li>
      <SidebarRow
        variant="action"
        asChild
        className="text-text-muted hover:text-text-secondary w-full text-left"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
        >
          <SidebarRowMain>
            <SidebarRowIconSlot>
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            </SidebarRowIconSlot>
            <span className="text-xs font-medium">
              Archived{open && rows && ` (${rows.length})`}
            </span>
          </SidebarRowMain>
        </button>
      </SidebarRow>
      <AnimatePresence initial={false}>
        {open && (
          <Collapse id={listId} className="px-3 pb-1 pl-8">
            {archives.isError ? (
              <div
                className="text-text-muted flex items-center justify-between gap-2 py-1 text-xs"
                role="alert"
              >
                Couldn’t load archived workspaces.
                <Button size="xs" variant="ghost" onClick={() => void archives.refetch()}>
                  Retry
                </Button>
              </div>
            ) : !rows?.length ? (
              <p className="text-text-muted py-1 text-xs" role="status">
                {rows ? "No archived workspaces here." : "Loading archived workspaces…"}
              </p>
            ) : (
              <ul aria-label="Archived workspaces">
                {rows.map((row) => (
                  <ArchiveRow key={row.id} row={row} />
                ))}
              </ul>
            )}
          </Collapse>
        )}
      </AnimatePresence>
    </li>
  );
}

function ArchiveRow({ row }: { row: ArchivedWorkspace }) {
  const restore = useUnarchiveWorkspace();
  const name = row.title || row.slug;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 py-1">
      <p className="text-text-secondary truncate text-sm" title={name}>
        {name}
      </p>
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Restore ${name}`}
        disabled={restore.isPending}
        onClick={() =>
          void restore.mutateAsync(row.id).catch((error) => toast.error(getErrorMessage(error)))
        }
      >
        Restore
      </Button>
      {row.archived_by && (
        <OriginCaption origin={row.archived_by} caption="Archived by" className="col-span-2" />
      )}
    </li>
  );
}
