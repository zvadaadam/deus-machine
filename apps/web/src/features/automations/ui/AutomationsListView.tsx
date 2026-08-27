/**
 * AutomationsListView — board 46a: header + filters + rows + suggestions.
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  CirclePlay,
  CirclePause,
  ClockFading,
  Ellipsis,
  LayoutTemplate,
  PenLine,
  Play,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";
import { cn } from "@/shared/lib/utils";
import {
  Button,
  Input,
  ScrollArea,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui";
import type { Automation } from "@/shared/types";
import {
  useDeleteAutomation,
  useRunAutomationNow,
  useToggleAutomation,
} from "../api/automations.queries";
import { formatTimeSince, formatTimeUntil, humanizeSchedule } from "../lib/schedule";
import { SUGGESTED_TEMPLATES } from "../lib/templates";
import type { EditorPrefill } from "./AutomationEditor";

type Filter = "all" | "active" | "paused";

export function AutomationsListView({
  automations,
  isLoading,
  onNew,
  onCreateWithAi,
  onOpenTemplates,
  onOpen,
}: {
  automations: Automation[];
  isLoading: boolean;
  onNew: (prefill?: EditorPrefill) => void;
  onCreateWithAi: () => void;
  onOpenTemplates: () => void;
  onOpen: (automation: Automation) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return automations.filter((a) => {
      if (filter !== "all" && a.status !== filter) return false;
      if (query && !a.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [automations, filter, search]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-8 py-12">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-text-primary text-xl font-semibold">Automations</h1>
            <p className="text-text-tertiary text-sm">
              Prompts that run on a schedule in your cloud sandboxes — even with this Mac closed.
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                New automation
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onCreateWithAi}>
                <Sparkles className="h-3.5 w-3.5" /> Create with AI
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onNew()}>
                <PenLine className="h-3.5 w-3.5" /> Manually
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenTemplates}>
                <LayoutTemplate className="h-3.5 w-3.5" /> From template
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {(["all", "active", "paused"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  "h-7 rounded-full px-3 text-sm capitalize transition-colors duration-150",
                  filter === f
                    ? "bg-bg-selection text-text-primary font-medium"
                    : "text-text-tertiary hover:text-text-secondary"
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search automations"
            className="w-60"
          />
        </div>

        {/* List */}
        {isLoading ? null : filtered.length === 0 && automations.length === 0 ? (
          <EmptyState onNew={() => onNew()} />
        ) : (
          <div className="flex flex-col">
            {filtered.map((automation, i) => (
              <div key={automation.id}>
                {i > 0 && <div className="bg-border-subtle h-px w-full" />}
                <AutomationRow automation={automation} onOpen={() => onOpen(automation)} />
              </div>
            ))}
          </div>
        )}

        {/* Suggestions — top templates; the full gallery lives one click away */}
        {automations.length < 3 && (
          <div className="flex flex-col gap-3 pt-2">
            <div className="flex items-center justify-between">
              <span className="text-text-muted text-2xs font-semibold tracking-wider">
                SUGGESTIONS
              </span>
              <button
                type="button"
                onClick={onOpenTemplates}
                className="text-text-tertiary hover:text-text-secondary text-xs transition-colors duration-150"
              >
                Browse all templates →
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {SUGGESTED_TEMPLATES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onNew(s.prefill)}
                  className="border-border-subtle bg-bg-elevated hover:border-border-default flex flex-col gap-1.5 rounded-lg border p-3.5 text-left transition-colors duration-150"
                >
                  <div className="flex items-center gap-2">
                    <s.icon className="text-text-secondary h-[15px] w-[15px] shrink-0" />
                    <span className="text-text-primary text-sm font-medium">{s.title}</span>
                  </div>
                  <span className="text-text-muted text-2xs">{s.schedule}</span>
                  <span className="text-text-tertiary text-xs leading-relaxed">
                    {s.description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function AutomationRow({ automation, onOpen }: { automation: Automation; onOpen: () => void }) {
  const paused = automation.status === "paused";
  const StatusIcon = paused ? CirclePause : CirclePlay;

  const meta = [
    humanizeSchedule(automation.cron),
    paused
      ? "Paused"
      : formatTimeUntil(automation.next_run_at)
        ? `Next run ${formatTimeUntil(automation.next_run_at)}`
        : null,
    automation.repo_name,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="group hover:bg-foreground/[0.03] flex h-[54px] cursor-pointer items-center gap-3 rounded-lg px-2 transition-colors duration-150"
    >
      <StatusIcon
        className={cn("h-4 w-4 shrink-0", paused ? "text-text-muted" : "text-text-secondary")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-sm font-medium",
            paused ? "text-text-tertiary" : "text-text-primary"
          )}
        >
          {automation.name}
        </span>
        <span className={cn("truncate text-xs", paused ? "text-text-muted" : "text-text-tertiary")}>
          {meta}
        </span>
      </div>
      <LastRun automation={automation} />
      <RowMenu automation={automation} onOpen={onOpen} />
    </div>
  );
}

function LastRun({ automation }: { automation: Automation }) {
  const since = formatTimeSince(automation.last_run_at);
  if (!since) return <span className="text-text-muted w-20 shrink-0 text-right text-xs">—</span>;
  const failed =
    automation.last_run_status === "failed" || (automation.consecutive_failures ?? 0) > 0;
  return (
    <div className="flex w-28 shrink-0 items-center justify-end gap-1.5">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          failed
            ? "bg-destructive"
            : automation.last_run_status === "succeeded"
              ? "bg-success"
              : "bg-text-disabled"
        )}
      />
      <span className="text-text-muted text-xs">{failed ? `Failed ${since}` : since}</span>
    </div>
  );
}

/** Row overflow: Run now · Pause/Resume · Edit · Delete. */
export function RowMenu({
  automation,
  onOpen,
  openLabel = "Open",
}: {
  automation: Automation;
  onOpen?: () => void;
  openLabel?: string;
}) {
  const runNow = useRunAutomationNow();
  const toggle = useToggleAutomation();
  const remove = useDeleteAutomation();
  const paused = automation.status === "paused";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Automation actions"
          onClick={(e) => e.stopPropagation()}
          className="text-text-muted hover:text-text-secondary flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          onClick={() =>
            runNow.mutate(automation.id, {
              onSuccess: () => toast.success(`Running "${automation.name}"`),
              onError: (err) => toast.error(getErrorMessage(err)),
            })
          }
        >
          <Play className="h-3.5 w-3.5" /> Run now
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            toggle.mutate(
              { automationId: automation.id, status: paused ? "active" : "paused" },
              { onError: (err) => toast.error(getErrorMessage(err)) }
            )
          }
        >
          {paused ? (
            <>
              <CirclePlay className="h-3.5 w-3.5" /> Resume
            </>
          ) : (
            <>
              <CirclePause className="h-3.5 w-3.5" /> Pause
            </>
          )}
        </DropdownMenuItem>
        {onOpen && <DropdownMenuItem onClick={onOpen}>{openLabel}</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() =>
            remove.mutate(automation.id, {
              onSuccess: () => toast("Automation deleted"),
              onError: (err) => toast.error(getErrorMessage(err)),
            })
          }
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="border-border-subtle flex flex-col items-center gap-2.5 rounded-lg border px-6 py-10">
      <div className="bg-bg-elevated flex h-9 w-9 items-center justify-center rounded-md">
        <ClockFading className="text-text-secondary h-4 w-4" />
      </div>
      <span className="text-text-primary text-sm font-medium">No automations yet</span>
      <span className="text-text-tertiary text-xs">
        Ask the agent to schedule something — or create one manually.
      </span>
      <Button variant="outline" size="sm" onClick={onNew} className="mt-1.5">
        New automation
      </Button>
    </div>
  );
}
