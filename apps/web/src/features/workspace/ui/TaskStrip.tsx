/**
 * TaskStrip — collapsible task icon strip for the workspace header.
 *
 * Shows a single trigger icon (first task) that expands on hover to reveal
 * all task buttons + a Settings gear icon at the end. CSS-only animation
 * using group-hover + clip-path transition for zero-JS hover state.
 *
 * When no manifest exists, shows a ghost Sparkles icon (text-text-disabled)
 * where task icons would appear — teaching spatial memory for the feature.
 */

import { Settings, Wrench } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { uiActions } from "@/shared/stores/uiStore";
import type { NormalizedTask } from "../api/workspace.service";
import { TaskButton } from "./TaskButton";

interface TaskStripProps {
  tasks: NormalizedTask[];
  hasManifest: boolean;
  disabled?: boolean;
  onRunTask: (taskName: string) => void;
  /** Called when user clicks the ghost icon (no manifest). Sends /generate-opendevs-json to chat. */
  onSetupEnvironment?: () => void;
}

export function TaskStrip({
  tasks,
  hasManifest,
  disabled,
  onRunTask,
  onSetupEnvironment,
}: TaskStripProps) {
  // No manifest — show ghost wrench + label as absent affordance
  if (!hasManifest) {
    return (
      <div className="flex items-center">
        <span className="bg-border-subtle mx-1 h-3 w-px" />
        <button
          type="button"
          onClick={onSetupEnvironment}
          aria-label="Set up your environment"
          className="text-text-disabled hover:text-text-muted flex h-6 items-center gap-1 rounded-lg px-1.5 text-sm transition-colors duration-200"
        >
          <Wrench className="h-3 w-3 shrink-0" />
          <span>Set up environment</span>
        </button>
      </div>
    );
  }

  const iconTasks = tasks.filter((t) => t.icon && t.icon !== "terminal");
  const [firstTask, ...restTasks] = iconTasks;

  const handleOpenSettings = () => {
    uiActions.setActiveSettingsSection("environment");
    uiActions.openSettings();
  };

  const settingsButton = (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleOpenSettings}
          aria-label="Open environment settings"
          className="text-text-muted hover:text-text-secondary hover:bg-bg-muted relative flex h-6 w-6 items-center justify-center rounded-lg transition-colors duration-200 before:absolute before:inset-[-10px] before:content-['']"
        >
          <Settings className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">Environment settings</p>
      </TooltipContent>
    </Tooltip>
  );

  // No tasks defined — show just the settings icon (always visible)
  if (!firstTask) {
    return (
      <div className="flex items-center">
        <span className="bg-border-subtle mx-1 h-3 w-px" />
        {settingsButton}
      </div>
    );
  }

  return (
    <div className="flex items-center">
      <span className="bg-border-subtle mx-1 h-3 w-px" />

      {/* Hover group — first icon is always visible, rest slide out */}
      <div className="group/tasks flex items-center">
        {/* Trigger: first task icon (always visible) */}
        <TaskButton
          name={firstTask.name}
          icon={firstTask.icon}
          description={firstTask.description}
          disabled={disabled}
          onClick={() => onRunTask(firstTask.name)}
        />

        {/* Expandable strip — hidden by default, revealed on hover via clip-path (GPU-composited) */}
        <div
          className={cn(
            "flex items-center opacity-0 [clip-path:inset(0_100%_0_0)]",
            "transition-[clip-path,opacity] duration-200 [transition-timing-function:cubic-bezier(.165,.84,.44,1)]",
            "group-hover/tasks:opacity-100 group-hover/tasks:[clip-path:inset(0_0%_0_0)]"
          )}
        >
          {restTasks.map((task) => (
            <TaskButton
              key={task.name}
              name={task.name}
              icon={task.icon}
              description={task.description}
              disabled={disabled}
              onClick={() => onRunTask(task.name)}
            />
          ))}

          {/* Settings icon — always last in expanded strip */}
          {settingsButton}
        </div>
      </div>
    </div>
  );
}
