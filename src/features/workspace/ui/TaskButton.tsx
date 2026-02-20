/**
 * TaskButton — compact icon button for running manifest tasks from the header.
 *
 * Maps a string icon name (from hive.json) to a lucide-react component.
 * Ghost style, sm size. Shows tooltip with task name + description.
 */

import { Loader2, Terminal } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { TASK_ICON_MAP } from "@/shared/lib/taskIcons";

interface TaskButtonProps {
  name: string;
  icon: string;
  description?: string | null;
  isRunning?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function TaskButton({
  name,
  icon,
  description,
  isRunning,
  disabled,
  onClick,
}: TaskButtonProps) {
  const Icon = TASK_ICON_MAP[icon] ?? Terminal;
  const tooltipText = description ? `${name}: ${description}` : name;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled || isRunning}
          aria-label={`Run task: ${name}`}
          className={cn(
            "text-text-muted hover:text-text-secondary hover:bg-bg-muted relative flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-200 before:absolute before:inset-[-10px] before:content-['']",
            (disabled || isRunning) && "cursor-not-allowed opacity-50"
          )}
        >
          {isRunning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Icon className="h-3 w-3" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">{tooltipText}</p>
      </TooltipContent>
    </Tooltip>
  );
}
