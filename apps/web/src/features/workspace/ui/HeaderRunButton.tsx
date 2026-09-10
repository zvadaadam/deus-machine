/**
 * HeaderRunButton — split button for running project commands from the workspace header.
 *
 * Left side: runs the last-used task (or first task) on click.
 * Right side: dropdown chevron listing all tasks + environment settings.
 *
 * Same split-button pattern as HeaderOpenButton (Open with editor).
 * With no commands, opens environment settings. Setup suggestions belong in the empty chat.
 */

import { useState, useEffect, useRef } from "react";
import { ChevronDown, Settings, Terminal, Play, Check } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import { useLastRun } from "@/shared/hooks/useLastRun";
import type { ProjectTask } from "../api/workspace.service";

interface HeaderRunButtonProps {
  tasks: ProjectTask[];
  disabled?: boolean;
  onRunTask: (taskName: string) => void;
  onOpenSettings: () => void;
}

export function HeaderRunButton({
  tasks,
  disabled,
  onRunTask,
  onOpenSettings,
}: HeaderRunButtonProps) {
  if (tasks.length === 0) {
    return <SettingsButton onOpenSettings={onOpenSettings} />;
  }

  return (
    <TaskSplitButton
      tasks={tasks}
      disabled={disabled}
      onRunTask={onRunTask}
      onOpenSettings={onOpenSettings}
    />
  );
}

// ---------------------------------------------------------------------------
// TaskSplitButton — split button: quick run (last-used) + dropdown
// ---------------------------------------------------------------------------

function TaskSplitButton({
  tasks,
  disabled,
  onRunTask,
  onOpenSettings,
}: {
  tasks: ProjectTask[];
  disabled?: boolean;
  onRunTask: (taskName: string) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [lastTaskName, setLastTaskName] = useLastRun();
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isHoveringRef = useRef(false);

  // Default task: last-run, or first in the list
  const lastTask = lastTaskName ? (tasks.find((t) => t.name === lastTaskName) ?? null) : null;
  const defaultTask = lastTask ?? tasks[0];
  const DefaultIcon = defaultTask.name === "run" ? Play : Terminal;

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

  const tooltipText = defaultTask.command;

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
              aria-label={defaultTask.name === "run" ? "Run app" : `Run task: ${defaultTask.name}`}
              className="text-text-subtle hover:bg-bg-muted flex h-full shrink-0 items-center gap-1.5 rounded-l-lg px-2 transition-colors duration-200"
            >
              <DefaultIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[100px] shrink-0 truncate text-sm font-medium">
                {defaultTask.name === "run" ? "Run app" : defaultTask.name}
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
          const Icon = task.name === "run" ? Play : Terminal;
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
                <span className={cn("truncate", isDefault && "font-medium")}>
                  {task.name === "run" ? "Run app" : task.name}
                </span>
              </div>
              {isDefault && <Check className="text-text-muted ml-auto h-3 w-3 shrink-0" />}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            onOpenSettings();
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

function SettingsButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpenSettings}
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
