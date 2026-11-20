import { useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import type { WorkspaceStart } from "@/features/workspace/lib/startState";
import { useStartRecovery } from "@/features/workspace/hooks/useStartRecovery";
import { useSetupActions } from "@/features/workspace/hooks/useSetupActions";
import { EnvGroup } from "./EnvGroup";

/**
 * A workspace's start, as a line in its transcript: the same line a cloud
 * computer's provisioning gets (EnvGroup). Starting, its steps are in view;
 * ready, they fold behind "Workspace ready" and any warning stays in view; a
 * start that failed keeps them open with why, Retry (the same workspace again)
 * and Delete, and what the tool itself printed behind "Details".
 */
export function WorkspaceStartGroup({
  workspaceId,
  repoId,
  start,
}: {
  workspaceId: string;
  /** Its project: a deleted workspace's message goes back to Home with it chosen. */
  repoId?: string;
  start: WorkspaceStart;
}) {
  const setupActions = useSetupActions(workspaceId);
  return (
    <EnvGroup
      title={start.summary}
      where={start.cloud ? "cloud" : "local"}
      state={start.phase === "starting" ? "running" : start.phase}
      steps={[
        ...start.steps.map(({ state, ...step }) => ({
          ...step,
          icon: state,
          actions:
            !start.cloud && start.phase === "ready" && step.key === "setup" && step.warning
              ? setupActions
              : undefined,
        })),
        ...(start.failure
          ? [{ key: "failure", label: start.failure.reason, icon: "error" as const }]
          : []),
      ]}
      footer={
        start.failure && (
          <StartFailure workspaceId={workspaceId} repoId={repoId} failure={start.failure} />
        )
      }
    />
  );
}

function StartFailure({
  workspaceId,
  repoId,
  failure,
}: {
  workspaceId: string;
  repoId?: string;
  failure: NonNullable<WorkspaceStart["failure"]>;
}) {
  const { retryStart, deleteWorkspace, retrying, deleting } = useStartRecovery(workspaceId, repoId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const busy = retrying || deleting;

  return (
    <>
      <div className="mt-0.5 flex min-h-7 items-center gap-2 pointer-coarse:[&_button]:min-h-11">
        {failure.detail && (
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
            className="control-interaction text-text-tertiary hover:text-text-secondary mr-auto flex items-center gap-2 rounded-lg"
          >
            <ChevronRight
              className={cn("h-3.5 w-3.5 transition-transform", detailsOpen && "rotate-90")}
              aria-hidden
            />
            Details
          </button>
        )}
        {failure.recoverable ? (
          <div className="ml-auto flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={deleteWorkspace} disabled={busy}>
              Delete
            </Button>
            <Button size="xs" onClick={retryStart} disabled={busy}>
              {retrying && <Loader2 className="animate-spin motion-reduce:animate-none" />}
              Retry
            </Button>
          </div>
        ) : (
          <p className="text-text-muted text-xs">Archive this workspace and start a new one.</p>
        )}
      </div>
      {detailsOpen && (
        <pre className="border-border-subtle bg-bg-elevated text-text-tertiary ms-5.5 max-h-48 overflow-auto rounded-lg border px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap select-text">
          {failure.detail}
        </pre>
      )}
    </>
  );
}
