/**
 * AutomationRail — the compressed list on the left of the editor/detail split
 * (boards 46b/46c). 340px, condensed two-line rows, selected row highlighted.
 */

import { CirclePause, CirclePlay, ChevronLeft, Plus } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { ScrollArea } from "@/components/ui";
import type { Automation } from "@/shared/types";
import { humanizeSchedule } from "../lib/schedule";

export function AutomationRail({
  automations,
  selectedId,
  onSelect,
  onNew,
  onBack,
}: {
  automations: Automation[];
  selectedId: string | null;
  onSelect: (automation: Automation) => void;
  onNew: () => void;
  onBack: () => void;
}) {
  return (
    <>
      {/* Mobile stacks: the editor/detail panel takes the full width and its
          back affordance returns to the list — a fixed rail would leave the
          panel ~50px on a 390px viewport. */}
      <div className="hidden w-[340px] shrink-0 flex-col py-4 pr-3 pl-3 md:flex">
        <div className="flex items-center justify-between px-2 pb-2.5">
          <button
            type="button"
            onClick={onBack}
            className="text-text-primary hover:text-text-secondary flex items-center gap-1 text-sm font-semibold transition-colors duration-150"
          >
            <ChevronLeft className="text-text-muted h-3.5 w-3.5" />
            Automations
          </button>
          <button
            type="button"
            aria-label="New automation"
            onClick={onNew}
            className="text-text-muted hover:text-text-secondary flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150"
          >
            <Plus className="h-[15px] w-[15px]" />
          </button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5">
            {automations.map((automation) => {
              const paused = automation.status === "paused";
              const StatusIcon = paused ? CirclePause : CirclePlay;
              const selected = automation.id === selectedId;
              return (
                <button
                  key={automation.id}
                  type="button"
                  onClick={() => onSelect(automation)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-[7px] text-left transition-colors duration-150",
                    selected ? "bg-bg-selection" : "hover:bg-foreground/[0.04]"
                  )}
                >
                  <StatusIcon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      paused ? "text-text-muted" : "text-text-secondary"
                    )}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span
                      className={cn(
                        "truncate text-sm font-medium",
                        paused ? "text-text-tertiary" : "text-text-primary"
                      )}
                    >
                      {automation.name}
                    </span>
                    <span className="text-text-muted text-2xs truncate">
                      {paused ? "Paused" : humanizeSchedule(automation.cron)}
                    </span>
                  </div>
                  {automation.last_run_status === "failed" && (
                    <span className="bg-destructive ml-auto h-1.5 w-1.5 shrink-0 rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>
      <div className="bg-border-subtle w-px shrink-0" />
    </>
  );
}
