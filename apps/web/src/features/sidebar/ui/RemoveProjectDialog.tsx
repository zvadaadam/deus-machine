import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "@shared/api";
import type { OutputOf } from "@shared/api/op";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRemoveRepo } from "@/features/repository/api";
import { call } from "@/platform/ws";
import { abbreviatePath } from "@/shared/lib/formatters";

interface Props {
  repoId: string;
  name: string;
}

export function RemoveProjectDialog({
  repoId,
  name,
  disabledReason,
}: Props & { disabledReason?: string }) {
  const button = (
    <button
      type="button"
      aria-label={`Remove ${name} from Deus`}
      aria-disabled={disabledReason ? true : undefined}
      aria-description={disabledReason}
      onClick={(event) => event.stopPropagation()}
      className={
        disabledReason
          ? "text-text-disabled cursor-not-allowed"
          : "text-text-muted hover:text-text-tertiary cursor-pointer [&_*]:cursor-pointer"
      }
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>{button}</DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {disabledReason ?? "Remove project"}
        </TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-sm" onClick={(event) => event.stopPropagation()}>
        <RemovalConfirmation repoId={repoId} name={name} />
      </DialogContent>
    </Dialog>
  );
}

function RemovalConfirmation({ repoId, name }: Props) {
  const preview = useQuery({
    queryKey: [api.repoRemoval.name, repoId],
    queryFn: () => call(api.repoRemoval, { repoId }),
    refetchOnMount: "always",
    retry: false,
  });
  const remove = useRemoveRepo();
  const details = preview.isSuccess && !preview.isFetching ? preview.data : undefined;
  const statusText = preview.isError ? getErrorMessage(preview.error) : "Checking this project…";
  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-4 wrap-anywhere">Remove {name} from Deus?</DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-2 wrap-anywhere">
            {details ? <RemovalDescription {...details} /> : statusText}
          </div>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline" size="sm">
            Cancel
          </Button>
        </DialogClose>
        {details && (
          <Button
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ repoId, confirmed: details })}
          >
            Remove
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function RemovalDescription({ rootPath, folderExists, counts }: OutputOf<typeof api.repoRemoval>) {
  const { archivedWorkspaces, chats, automations } = counts;
  return (
    <>
      <p>
        {archivedWorkspaces === 0
          ? "This project has no workspaces or chats."
          : `This deletes ${archivedWorkspaces} archived workspace${archivedWorkspaces === 1 ? "" : "s"} and ${chats} chat${chats === 1 ? "" : "s"} from Deus.`}
      </p>
      <p>
        {!rootPath
          ? "The repository stays on GitHub."
          : folderExists === false
            ? `Deus can’t find the project folder at ${abbreviatePath(rootPath)}.`
            : `The folder ${abbreviatePath(rootPath)}, its checkouts and its Git branches stay on disk.`}
      </p>
      {archivedWorkspaces > 0 && <p>Deus also deletes any boards owned by those workspaces.</p>}
      {automations > 0 && (
        <p>
          Deus unlinks {automations} {automations === 1 ? "automation" : "automations"} from this
          project. {automations === 1 ? "Its schedule" : "Their schedules"} and run history stay on
          Deus Cloud.
        </p>
      )}
    </>
  );
}
