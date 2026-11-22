import { useId, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { ChevronRight } from "lucide-react";
import type { RepoGroup } from "@shared/types/workspace";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { OriginCaption } from "@/features/session/ui/SentFrom";
import {
  useArchivedWorkspaces,
  useUnarchiveWorkspace,
  type ArchivedWorkspace,
} from "@/features/workspace/api/workspace.queries";
import { cn } from "@/shared/lib/utils";
import { workspaceInPlace, type Organizations, type Place } from "../lib/location";
import { SidebarRow, SidebarRowMain, SidebarRowIconSlot } from "./SidebarRow";

export function ArchivedWorkspaces({
  repository,
  place,
  organizations,
}: {
  repository: RepoGroup & { archived_count?: number };
  place: Place;
  organizations: Organizations;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { repo_id: repositoryId, archived_count: count } = repository;
  const archives = useArchivedWorkspaces(repositoryId, count, open);
  if (count === undefined || (!open && !count)) return null;
  const rows = archives.isError
    ? undefined
    : archives.data?.filter((row) => workspaceInPlace(row, place, organizations));
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
            {archives.isError && (
              <div
                className="text-text-muted flex items-center justify-between gap-2 py-1 text-xs"
                role="alert"
              >
                Couldn’t load archived workspaces.
                <Button size="xs" variant="ghost" onClick={() => void archives.refetch()}>
                  Retry
                </Button>
              </div>
            )}
            {!archives.isError && !rows?.length && (
              <p className="text-text-muted py-1 text-xs" role="status">
                {rows ? "No archived workspaces here." : "Loading archived workspaces…"}
              </p>
            )}
            {!!rows?.length && (
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
        onClick={() => restore.mutate(row.id)}
      >
        Restore
      </Button>
      {row.archived_by && (
        <OriginCaption origin={row.archived_by} caption="Archived by" className="col-span-2" />
      )}
    </li>
  );
}
