/**
 * HeaderRunButton — split button for running manifest tasks from the workspace header.
 *
 * Left side: runs the last-used task (or first task) on click.
 * Right side: dropdown chevron listing all tasks + environment settings.
 *
 * Same split-button pattern as HeaderOpenButton (Open with editor).
 * When no manifest exists, shows a ghost "Set up environment" button.
 */

import { useState, useEffect, useRef } from "react";
import { ChevronDown, Settings, Terminal, Wrench, Check } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import { uiActions } from "@/shared/stores/uiStore";
import { TASK_ICON_MAP } from "@/shared/lib/taskIcons";
import { useLastRun } from "@/shared/hooks/useLastRun";
import type { NormalizedTask } from "../api/workspace.service";

interface HeaderRunButtonProps {
  tasks: NormalizedTask[];
  hasManifest: boolean;
  disabled?: boolean;
  onRunTask: (taskName: string) => void;
  /** Called when user clicks the ghost icon (no manifest). Sends /generate-deus-json to chat. */
  onSetupEnvironment?: () => void;
}

export function HeaderRunButton({
  tasks,
  hasManifest,
  disabled,
  onRunTask,
  onSetupEnvironment,
}: HeaderRunButtonProps) {
  // No manifest — show wrench icon (with setup handler) or fall back to settings
  if (!hasManifest) {
    if (!onSetupEnvironment) return <SettingsButton />;

    return (
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onSetupEnvironment}
            aria-label="Set up your environment"
            className="text-text-disabled hover:text-text-muted border-border-strong flex h-7 w-7 items-center justify-center rounded-lg border transition-colors duration-200"
          >
            <Wrench className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Set up environment</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (tasks.length === 0) {
    return <SettingsButton />;
  }

  return <TaskSplitButton tasks={tasks} disabled={disabled} onRunTask={onRunTask} />;
}

// ---------------------------------------------------------------------------
// TaskSplitButton — split button: quick run (last-used) + dropdown
// ---------------------------------------------------------------------------

function TaskSplitButton({
  tasks,
  disabled,
  onRunTask,
}: {
  tasks: NormalizedTask[];
  disabled?: boolean;
  onRunTask: (taskName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [lastTaskName, setLastTaskName] = useLastRun();
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isHoveringRef = useRef(false);

  // Default task: last-run, or first in the list
  const lastTask = lastTaskName ? (tasks.find((t) => t.name === lastTaskName) ?? null) : null;
  const defaultTask = lastTask ?? tasks[0];
  const DefaultIcon = TASK_ICON_MAP[defaultTask.icon] ?? Terminal;

  function handleRunTask(taskName: string) {
    setOpen(false);
    setLastTaskName(taskName);
    onRunTask(taskName);
  }

  function handleQuickRun() {
    handleRunTask(defaultTask.name);
  }

  function handleOpen() {
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    isHoveringRef.current = true;
    setOpen(true);
  }

  function handleClose() {
    isHoveringRef.current = false;
    closeTimeoutRef.current = setTimeout(() => {
      if (!isHoveringRef.current) setOpen(false);
    }, 50);
  }

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const tooltipText = defaultTask.description
    ? `${defaultTask.name}: ${defaultTask.description}`
    : defaultTask.name;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <div
        className={cn(
          "border-border-strong flex h-7 shrink-0 items-center rounded-lg border",
          disabled && "cursor-not-allowed opacity-50"
        )}
      >
        {/* Left: quick-run action */}
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleQuickRun}
              disabled={disabled}
              aria-label={`Run task: ${defaultTask.name}`}
              className="text-text-subtle hover:bg-bg-muted flex h-full shrink-0 items-center gap-1.5 rounded-l-lg px-2 transition-colors duration-200"
            >
              <DefaultIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[100px] shrink-0 truncate text-sm font-medium">
                {defaultTask.name}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">{tooltipText}</p>
          </TooltipContent>
        </Tooltip>

        {/* Divider */}
        <div className="bg-border-strong h-4 w-px shrink-0" />

        {/* Right: dropdown chevron */}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Choose task to run"
            className="text-text-muted hover:bg-bg-muted hover:text-text-subtle flex h-full shrink-0 items-center rounded-r-lg px-1.5 transition-colors duration-200"
            onPointerEnter={handleOpen}
            onPointerLeave={handleClose}
          >
            <ChevronDown className="h-2.5 w-2.5" />
          </button>
        </DropdownMenuTrigger>
      </div>

      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[180px] shadow-sm"
        onPointerEnter={handleOpen}
        onPointerLeave={handleClose}
      >
        {tasks.map((task) => {
          const Icon = TASK_ICON_MAP[task.icon] ?? Terminal;
          const isDefault = task.name === defaultTask.name;

          return (
            <DropdownMenuItem
              key={task.name}
              onClick={() => handleRunTask(task.name)}
              disabled={disabled}
              className="cursor-pointer gap-2 py-1.5 text-xs"
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <div className="flex min-w-0 flex-col">
                <span className={cn("truncate", isDefault && "font-medium")}>{task.name}</span>
                {task.description && (
                  <span className="text-text-muted truncate text-[10px]">{task.description}</span>
                )}
              </div>
              {isDefault && <Check className="text-text-muted ml-auto h-3 w-3 shrink-0" />}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            uiActions.setActiveSettingsSection("environment");
            uiActions.openSettings();
            setOpen(false);
          }}
          className="text-text-muted cursor-pointer gap-2 py-1.5 text-xs"
        >
          <Settings className="h-3.5 w-3.5 shrink-0" />
          Environment settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// SettingsButton — standalone settings icon when no tasks are defined
// ---------------------------------------------------------------------------

function SettingsButton() {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            uiActions.setActiveSettingsSection("environment");
            uiActions.openSettings();
          }}
          aria-label="Open environment settings"
          className="text-text-muted hover:text-text-secondary hover:bg-bg-muted border-border-strong flex h-7 w-7 items-center justify-center rounded-lg border transition-colors duration-200"
        >
          <Settings className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">Environment settings</p>
      </TooltipContent>
    </Tooltip>
  );
}
