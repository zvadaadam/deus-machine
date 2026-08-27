/**
 * AutomationDetail — the right panel of the split (board 46c): header with
 * Run now + Active switch, meta line, prompt box, auto-pause banner, run
 * history from the platform ledger. Opening a run adopts its cloud sandbox
 * session into deus and navigates to it.
 */

import { useEffect } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import { cn } from "@/shared/lib/utils";
import { Button, ScrollArea } from "@/components/ui";
import { Switch } from "@/components/ui/switch";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import type { Automation, AutomationRun } from "@/shared/types";
import {
  refreshAutomations,
  useAutomationRuns,
  useOpenAutomationRun,
  useRunAutomationNow,
  useToggleAutomation,
} from "../api/automations.queries";
import { formatDuration, formatRunWhen, humanizeSchedule } from "../lib/schedule";
import { RowMenu } from "./AutomationsListView";

const LIVE_RUN_POLL_MS = 10_000;

export function AutomationDetail({
  automation,
  onBack,
  onEdit,
}: {
  automation: Automation;
  onBack: () => void;
  onEdit: () => void;
}) {
  const runs = useAutomationRuns(automation.id);
  const runNow = useRunAutomationNow();
  const toggle = useToggleAutomation();
  const openRun = useOpenAutomationRun();
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);
  const closeAutomations = useUIStore((s) => s.closeAutomations);

  // Mirror the platform on mount, and keep mirroring while a run is live —
  // runs execute server-side, so their progress only arrives by re-reading
  // the ledger (scoped poll, the same exception the PR status check makes).
  const automationId = automation.id;
  const hasLiveRun = (runs.data ?? []).some(
    (run) => run.status === "queued" || run.status === "running"
  );
  useEffect(() => {
    refreshAutomations(automationId);
  }, [automationId]);
  useEffect(() => {
    if (!hasLiveRun) return;
    const timer = setInterval(() => refreshAutomations(automationId), LIVE_RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [automationId, hasLiveRun]);

  const active = automation.status === "active";
  const meta = [
    humanizeSchedule(automation.cron),
    automation.timezone,
    automation.repo_name ?? automation.environment,
    "Deus Cloud",
    automation.session_policy === "fresh_session" ? "Fresh chat per run" : "Continues one chat",
  ]
    .filter(Boolean)
    .join(" · ");

  const handleOpenRun = (run: AutomationRun) => {
    openRun.mutate(run.id, {
      onSuccess: ({ workspaceId }) => {
        closeAutomations();
        selectWorkspace(workspaceId);
      },
      onError: (err) => toast.error(getErrorMessage(err)),
    });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Panel header */}
      <div className="flex items-center justify-between px-8 pt-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            aria-label="Back to automations"
            onClick={onBack}
            className="text-text-secondary hover:bg-foreground/[0.04] flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-text-primary truncate text-base font-semibold">
            {automation.name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button
            variant="outline"
            onClick={() =>
              runNow.mutate(automation.id, {
                onSuccess: () => toast.success(`Running "${automation.name}"`),
                onError: (err) => toast.error(getErrorMessage(err)),
              })
            }
            disabled={runNow.isPending}
          >
            Run now
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-text-secondary text-sm">Active</span>
            <Switch
              checked={active}
              onCheckedChange={(checked) =>
                toggle.mutate(
                  { automationId: automation.id, status: checked ? "active" : "paused" },
                  { onError: (err) => toast.error(getErrorMessage(err)) }
                )
              }
            />
          </div>
          <RowMenu automation={automation} onOpen={onEdit} openLabel="Edit" />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-8 py-6">
          <span className="text-text-tertiary text-xs">{meta}</span>

          {automation.paused_reason === "auto_failures" && (
            <div className="border-border-subtle bg-bg-elevated flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <span className="bg-warning h-8 w-0.5 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-text-primary text-sm font-medium">
                  Paused automatically after 5 failed runs
                </span>
                <span className="text-text-tertiary text-xs">
                  Resuming forgives the failure streak and re-arms the schedule.
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  toggle.mutate(
                    { automationId: automation.id, status: "active" },
                    { onError: (err) => toast.error(getErrorMessage(err)) }
                  )
                }
              >
                Resume
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-text-muted text-2xs font-semibold tracking-wider">PROMPT</span>
            <button
              type="button"
              onClick={onEdit}
              className="border-border-subtle bg-bg-elevated hover:border-border-default rounded-lg border p-3 text-left transition-colors duration-150"
            >
              <p className="text-text-secondary text-sm leading-relaxed whitespace-pre-wrap">
                {automation.prompt}
              </p>
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-text-muted text-2xs font-semibold tracking-wider">
              RUN HISTORY
            </span>
            {(runs.data ?? []).length === 0 ? (
              <span className="text-text-muted py-2 text-sm">
                No runs yet — the first one fires{" "}
                {active ? "on schedule, or press Run now." : "once you resume it."}
              </span>
            ) : (
              <div className="flex flex-col">
                {(runs.data ?? []).map((run, i) => (
                  <div key={run.id}>
                    {i > 0 && <div className="bg-border-subtle h-px w-full" />}
                    <RunRow
                      run={run}
                      index={(runs.data ?? []).length - i}
                      opening={openRun.isPending && openRun.variables === run.id}
                      onOpen={handleOpenRun}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function RunRow({
  run,
  index,
  opening,
  onOpen,
}: {
  run: AutomationRun;
  index: number;
  opening: boolean;
  onOpen: (run: AutomationRun) => void;
}) {
  const { Icon, color, spin } = runGlyph(run);
  const duration = formatDuration(run.started_at, run.completed_at);
  const detail = run.status === "failed" ? run.error_message : run.summary;
  const openable = !!run.provider_session_id;

  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      disabled={!openable || opening}
      className="enabled:hover:bg-foreground/[0.03] flex h-11 w-full items-center gap-2.5 rounded-md px-1.5 text-left transition-colors duration-150 disabled:cursor-default"
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", color, spin && "animate-spin")} />
      <span className="text-text-primary shrink-0 text-sm font-medium">Run #{index}</span>
      <span className="text-text-muted shrink-0 text-xs">
        {formatRunWhen(run.started_at ?? run.scheduled_at)}
      </span>
      <span className="text-text-tertiary min-w-0 flex-1 truncate text-right text-xs">
        {detail ?? ""}
      </span>
      {duration && <span className="text-text-muted shrink-0 text-xs">{duration}</span>}
      {typeof run.cost === "number" && (
        <span className="text-text-muted shrink-0 text-xs">${run.cost.toFixed(2)}</span>
      )}
      {openable && <ChevronRight className="text-text-muted h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}

function runGlyph(run: AutomationRun): { Icon: typeof CircleCheck; color: string; spin?: boolean } {
  switch (run.status) {
    case "succeeded":
      return { Icon: CircleCheck, color: "text-success" };
    case "failed":
      return { Icon: CircleX, color: "text-destructive" };
    case "skipped":
      return { Icon: CircleMinus, color: "text-text-disabled" };
    case "queued":
      return { Icon: Clock, color: "text-text-muted" };
    default:
      return { Icon: Loader2, color: "text-text-secondary", spin: true };
  }
}
