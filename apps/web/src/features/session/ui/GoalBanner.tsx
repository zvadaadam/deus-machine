import { useEffect, useState, type MouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play, Target, X } from "lucide-react";
import type { ActiveGoal, GoalStatus } from "@shared/goals";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";

interface GoalBannerProps {
  goal?: ActiveGoal | null;
  onResume?: () => void;
  onCancel?: () => void;
}

export function GoalBanner({ goal, onResume, onCancel }: GoalBannerProps) {
  const [hiddenTerminalKey, setHiddenTerminalKey] = useState<string | null>(null);
  const terminalKey =
    goal && isTerminalStatus(goal.status)
      ? `${goal.goalId}:${goal.status}:${goal.updatedAt}`
      : null;

  useEffect(() => {
    if (!terminalKey) return;

    const id = window.setTimeout(() => {
      setHiddenTerminalKey(terminalKey);
    }, 3_000);
    return () => window.clearTimeout(id);
  }, [terminalKey]);

  const visibleGoal = terminalKey && hiddenTerminalKey === terminalKey ? null : goal;
  const dismissVisibleTerminalGoal = () => {
    if (terminalKey) setHiddenTerminalKey(terminalKey);
  };

  return (
    <AnimatePresence initial={false}>
      {visibleGoal ? (
        <GoalBannerCard
          key={`${visibleGoal.goalId}:${visibleGoal.status}`}
          goal={visibleGoal}
          onResume={onResume}
          onCancel={onCancel}
          onDismiss={dismissVisibleTerminalGoal}
        />
      ) : null}
    </AnimatePresence>
  );
}

function GoalBannerCard({
  goal,
  onResume,
  onCancel,
  onDismiss,
}: {
  goal: ActiveGoal;
  onResume?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
}) {
  const isActive = goal.status === "active";
  const elapsedSeconds = useElapsedSeconds(goal.createdAt, isActive, goal.timeUsedSeconds);
  const [expanded, setExpanded] = useState(false);
  const status = statusMeta(goal.status);

  const budgetLabel =
    goal.tokenBudget === null
      ? `${formatNumber(goal.spentTokens)} tokens`
      : `${formatNumber(goal.spentTokens)} / ${formatNumber(goal.tokenBudget)} tokens`;

  const handleCancel = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (isTerminalStatus(goal.status)) {
      onDismiss?.();
    } else {
      onCancel?.();
    }
  };

  const handleResume = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onResume?.();
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2, ease: [0.215, 0.61, 0.355, 1] }}
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((e) => !e)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded((v) => !v);
        }
      }}
      className="bg-bg-muted/55 hover:bg-bg-muted/70 ring-border-subtle/60 relative z-0 mx-3 -mb-2 cursor-pointer rounded-t-xl px-3.5 pt-2 pb-2.5 shadow-sm ring-1 backdrop-blur-md transition-colors"
    >
      <div className="flex items-start gap-2">
        <Target className="text-text-muted mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <motion.div
              layout="position"
              className={cn(
                "text-text-secondary min-w-0 text-xs font-medium",
                isActive && "tool-loading-shimmer",
                !expanded && "truncate"
              )}
            >
              {goal.objective}
            </motion.div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                status.className
              )}
            >
              <status.icon className="size-2.5" aria-hidden="true" />
              {status.label}
            </span>
          </div>
          <motion.div
            layout="position"
            className="text-text-muted mt-0.5 flex items-center gap-1.5 text-[11px] tabular-nums"
          >
            <span>{budgetLabel}</span>
            <span className="text-text-disabled">·</span>
            <span>{formatDuration(elapsedSeconds)}</span>
          </motion.div>
        </div>
        {goal.status === "paused" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Resume goal"
            aria-label="Resume goal"
            onClick={handleResume}
            className="text-text-muted hover:text-text-secondary -mt-0.5 size-6 shrink-0 rounded-md"
          >
            <Play className="size-3.5" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Dismiss goal"
          aria-label="Dismiss goal"
          onClick={handleCancel}
          className="text-text-muted hover:text-text-secondary -mt-0.5 size-6 shrink-0 rounded-md"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </motion.div>
  );
}

function useElapsedSeconds(
  startedAtSeconds: number,
  ticking: boolean,
  fallbackSeconds: number
): number {
  const [elapsed, setElapsed] = useState(fallbackSeconds);

  useEffect(() => {
    if (!ticking) return;

    const tick = () => setElapsed(Math.max(0, Math.floor(Date.now() / 1000) - startedAtSeconds));
    const initialId = window.setTimeout(tick, 0);
    const intervalId = window.setInterval(tick, 1_000);
    return () => {
      window.clearTimeout(initialId);
      window.clearInterval(intervalId);
    };
  }, [startedAtSeconds, ticking]);

  return ticking ? elapsed : fallbackSeconds;
}

function statusMeta(status: GoalStatus): {
  label: string;
  icon: typeof Target;
  className: string;
} {
  switch (status) {
    case "active":
      return {
        label: "Running",
        icon: Target,
        className: "bg-accent-green/15 text-accent-green",
      };
    case "paused":
      return {
        label: "Paused",
        icon: Pause,
        className: "bg-warning/15 text-warning",
      };
    case "complete":
      return {
        label: "Complete",
        icon: Target,
        className: "bg-primary/10 text-primary",
      };
    case "budget_limited":
      return {
        label: "Budget",
        icon: Target,
        className: "bg-destructive/10 text-destructive",
      };
  }
}

function isTerminalStatus(status: GoalStatus): boolean {
  return status === "complete" || status === "budget_limited";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

function formatNumber(value: number): string {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value
  );
}
