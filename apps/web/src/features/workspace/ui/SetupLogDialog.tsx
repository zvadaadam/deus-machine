import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { OutputBlock } from "@/components/ui/output-block";
import { call } from "@/platform/ws";

export function SetupLogDialog({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactElement;
}) {
  return (
    <Dialog key={workspaceId}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="gap-3 sm:max-w-xl pointer-coarse:[&>[data-slot=dialog-close]]:before:absolute pointer-coarse:[&>[data-slot=dialog-close]]:before:-inset-2"
      >
        <DialogTitle className="pe-6">Setup log</DialogTitle>
        <SetupLog workspaceId={workspaceId} />
      </DialogContent>
    </Dialog>
  );
}

// DialogContent mounts this read on opening. Another run can replace the entire log.
function SetupLog({ workspaceId }: { workspaceId: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: [api.setupLogs.name, workspaceId],
    queryFn: () => call(api.setupLogs, { workspaceId }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (data?.logs) {
    return (
      <OutputBlock
        tabIndex={0}
        aria-label="Setup output"
        role="region"
        className="focus-visible:ring-ring max-h-[60dvh] min-w-0 text-sm leading-5 wrap-anywhere select-text focus-visible:ring-2 focus-visible:outline-none"
      >
        {data.logs}
      </OutputBlock>
    );
  }
  return (
    <p className="text-text-secondary text-base" role="status">
      {isPending
        ? "Loading setup log…"
        : isError
          ? "Couldn't load the setup log."
          : "No setup log is available."}
    </p>
  );
}
