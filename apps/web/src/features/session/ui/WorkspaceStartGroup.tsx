import { useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import type { WorkspaceStart } from "@/features/workspace/lib/startState";
import { useStartRecovery } from "@/features/workspace/hooks/useStartRecovery";
import { EnvGroup, EnvNotice, type EnvLine } from "./EnvGroup";

/**
 * A workspace's start, as a line in its transcript: the same line a cloud
 * computer's provisioning gets (EnvGroup). Starting, the line is the step in
 * progress; ready, it folds the steps away and keeps any warning in view; a
 * start that failed shows why, with Retry (the same workspace again) and
 * Delete, and what the tool itself printed behind "Details".
 */
export function WorkspaceStartGroup({
  workspaceId,
  start,
}: {
  workspaceId: string;
  start: WorkspaceStart;
}) {
  const steps: EnvLine[] = start.steps.map((step) => ({
    key: step.key,
    label: step.label,
    icon: step.state,
    tone: step.state === "warning" ? "warning" : undefined,
  }));
  // While starting, the line IS the step in progress; the ones before it fold under it.
  const detail = start.phase === "starting" ? steps.filter((s) => s.icon !== "active") : steps;
  const summary: EnvLine = {
    key: "summary",
    label: start.summary,
    icon: start.phase === "failed" ? "error" : start.phase === "ready" ? "done" : "active",
    tone: start.phase === "failed" ? "error" : start.phase === "ready" ? "ready" : undefined,
  };
  const warnings = start.warnings.length;

  return (
    <EnvGroup
      summary={summary}
      detail={detail}
      note={warnings > 0 ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : undefined}
    >
      {start.warnings.map((warning) => (
        <EnvNotice key={warning} tone="warning">
          {warning}
        </EnvNotice>
      ))}
      {start.failure && <StartFailure workspaceId={workspaceId} failure={start.failure} />}
    </EnvGroup>
  );
}

function StartFailure({
  workspaceId,
  failure,
}: {
  workspaceId: string;
  failure: NonNullable<WorkspaceStart["failure"]>;
}) {
  const { retryStart, deleteWorkspace, retrying, deleting } = useStartRecovery(workspaceId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const busy = retrying || deleting;

  return (
    <EnvNotice tone="error">
      <div className="flex flex-col gap-2" role="alert">
        <p className="text-balance">{failure.reason}</p>
        {failure.recoverable ? (
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={retryStart} disabled={busy}>
              {retrying && <Loader2 className="animate-spin motion-reduce:animate-none" />}
              Retry
            </Button>
            <Button size="xs" variant="ghost" onClick={deleteWorkspace} disabled={busy}>
              Delete
            </Button>
          </div>
        ) : (
          <p className="text-text-muted text-xs">Archive this workspace and start a new one.</p>
        )}
        {failure.detail && (
          <div className="flex flex-col items-start gap-1.5">
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
              className="control-interaction text-text-muted hover:text-text-secondary -ml-1 flex items-center gap-1 rounded-lg px-1 py-0.5 text-xs"
            >
              <ChevronRight
                className={cn("h-3 w-3 transition-transform", detailsOpen && "rotate-90")}
                aria-hidden
              />
              Details
            </button>
            {detailsOpen && (
              <pre className="border-border-subtle bg-bg-elevated text-text-tertiary max-h-48 w-full overflow-auto rounded-lg border px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap select-text">
                {failure.detail}
              </pre>
            )}
          </div>
        )}
      </div>
    </EnvNotice>
  );
}
