import { useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { tempo } from "@/shared/lib/tempo";
import type { WorkspaceStart } from "@/features/workspace/lib/startState";
import { useStartRecovery } from "@/features/workspace/hooks/useStartRecovery";
import { useSetupActions } from "@/features/workspace/hooks/useSetupActions";
import { EnvGroup } from "./EnvGroup";

/**
 * A workspace's start, as a line in its transcript: the same line a cloud
 * computer's provisioning gets (EnvGroup). Starting and running setup stay in
 * one chronological card; once settled, it folds behind "Workspace ready" (with
 * a warning icon when a non-blocking step warned); a fatal start failure stays
 * open with why, Retry, Delete, and Details.
 */
export function WorkspaceStartGroup({
  workspaceId,
  repoId,
  start,
  onSendAgentMessage,
}: {
  workspaceId: string;
  /** Its project: a deleted workspace's message goes back to Home with it chosen. */
  repoId?: string;
  start: WorkspaceStart;
  onSendAgentMessage?: (text: string) => void;
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
              ? { ...setupActions, onSendAgentMessage }
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
            <m.span
              aria-hidden
              animate={{ rotate: detailsOpen ? 90 : 0 }}
              transition={tempo.spring.moderate}
              className="inline-flex shrink-0"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </m.span>
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
      <AnimatePresence initial={false}>
        {detailsOpen && (
          <Collapse>
            <pre className="border-border-subtle bg-bg-elevated text-text-tertiary ms-5.5 max-h-48 overflow-auto rounded-lg border px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap select-text">
              {failure.detail}
            </pre>
          </Collapse>
        )}
      </AnimatePresence>
    </>
  );
}
