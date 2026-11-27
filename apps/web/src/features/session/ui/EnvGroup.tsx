/** The transcript's shared line for a local checkout or a cloud computer. */
import { useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import {
  ChevronRight,
  CircleCheck,
  Cloud,
  CloudOff,
  Laptop,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { Collapse } from "@/components/ui/collapse";
import type { StartWarning } from "@/features/workspace/lib/startState";
import {
  SetupWarningDetails,
  type SetupWarningActionSet,
} from "@/features/workspace/ui/WorkspaceSetupStatus";
import { tempo } from "@/shared/lib/tempo";
import { cn } from "@/shared/lib/utils";

export interface EnvLine {
  key: string;
  label: string;
  icon: "done" | "active" | "warning" | "error";
  warning?: StartWarning;
  actions?: SetupWarningActionSet;
}

const ICON = "size-3.5 shrink-0";
const ROW = "flex min-h-7.5 items-center gap-2 pointer-coarse:min-h-11";

interface EnvGroupProps {
  title: string;
  where: "local" | "cloud";
  state: "running" | "ready" | "asleep" | "failed";
  steps?: EnvLine[];
  /** A failed start's details, Retry and Delete, inside its steps card. */
  footer?: ReactNode;
}

export function EnvGroup({ title, where, state, steps = [], footer }: EnvGroupProps) {
  const titleButton = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const cardId = useId();

  const hasActive = steps.some((step) => step.icon === "active");
  const hasWarning = steps.some((step) => step.icon === "warning" || !!step.warning);
  const isWorking = state === "running" || hasActive;
  const hasCard = steps.length > 0 || !!footer;
  const foldable = hasCard && state !== "running" && state !== "failed";

  // Keep the card open while a step is actively running, then fold smoothly when settled.
  // Keying the manual toggle by phase resets automatically when setup finishes or restarts.
  const phaseKey = `${steps[0]?.key ?? ""}:${hasActive ? "active" : hasWarning ? "warn" : "clean"}`;
  const [toggled, setToggled] = useState<{ key: string; open: boolean } | null>(null);
  const defaultOpen = !foldable || hasActive;
  const open = hasCard && (toggled?.key === phaseKey ? toggled.open : defaultOpen);

  const Icon =
    state === "failed"
      ? TriangleAlert
      : state === "asleep"
        ? CloudOff
        : where === "cloud"
          ? Cloud
          : Laptop;

  const focusTitle = () => titleButton.current?.focus({ preventScroll: true });

  const renderStep = (line: EnvLine) => {
    const Mark =
      line.icon === "done" ? CircleCheck : line.icon === "active" ? Loader2 : TriangleAlert;
    const isWarning = line.icon === "warning" || !!line.warning;
    return (
      <div key={line.key} data-env-step={line.key} className="flex flex-col gap-1.5">
        <div
          role={line.icon === "error" ? "alert" : undefined}
          className={cn(
            "flex items-center gap-2",
            line.icon === "error" && "text-destructive/80",
            line.icon === "done" && "text-text-tertiary",
            line.icon === "active" && "text-text-secondary",
            isWarning && "text-text-primary font-medium"
          )}
        >
          <Mark
            aria-hidden
            className={cn(
              ICON,
              line.icon === "done" && "text-text-muted",
              line.icon === "active" && "animate-spin motion-reduce:animate-none",
              isWarning && "text-warning"
            )}
          />
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0">{line.label}</span>
            {line.warning?.preview && (
              <>
                <span aria-hidden className="text-text-muted font-normal">
                  ·
                </span>
                <samp className="text-text-tertiary min-w-0 truncate font-mono text-xs font-normal">
                  {line.warning.preview}
                </samp>
              </>
            )}
          </span>
        </div>
        {line.warning && (
          <SetupWarningDetails
            warning={line.warning}
            actions={line.actions ? { ...line.actions, onBeforeAction: focusTitle } : undefined}
            className="ms-5.5"
          />
        )}
      </div>
    );
  };

  const announcedSteps = steps.filter((step) => step.icon === "active" || step.icon === "warning");

  return (
    // The transcript is itself a polite log. Only the status labels below should announce.
    <div data-slot="env-group" aria-live="off" className="flex w-full min-w-0 flex-col text-sm">
      <button
        type="button"
        ref={titleButton}
        disabled={!foldable}
        aria-label={
          state === "ready" && !hasActive && hasWarning ? `${title}, with warning` : title
        }
        aria-expanded={foldable ? open : undefined}
        aria-controls={foldable && open ? cardId : undefined}
        onClick={() => setToggled({ key: phaseKey, open: !open })}
        className={cn(
          ROW,
          "focus-visible:ring-ring w-fit max-w-full rounded-lg px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:outline-none",
          foldable
            ? "control-interaction hover:bg-control-hover/60 cursor-pointer"
            : state !== "ready" && "opacity-80"
        )}
      >
        <Icon
          aria-hidden
          className={cn(ICON, state === "failed" ? "text-destructive/80" : "text-text-tertiary")}
        />
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "text-text-secondary font-medium",
            isWorking && ["text-muted-foreground", !reduceMotion && "tool-loading-shimmer"],
            state === "failed" && "text-destructive/80"
          )}
        >
          {title}
        </span>
        {state === "ready" && !hasActive && hasWarning && (
          <TriangleAlert aria-hidden className={cn(ICON, "text-warning")} />
        )}
        {foldable && (
          <m.span
            aria-hidden
            animate={{ rotate: open ? 90 : 0 }}
            transition={tempo.spring.moderate}
            className="text-text-tertiary inline-flex shrink-0"
          >
            <ChevronRight className="size-3" />
          </m.span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <Collapse id={cardId}>
            <div className="inset-ring-border-subtle mt-0.5 mb-1 flex max-w-xl flex-col gap-2 rounded-lg px-2.5 py-2.5 inset-ring">
              {steps.map(renderStep)}
              {footer}
            </div>
          </Collapse>
        )}
      </AnimatePresence>

      {/* Polite screen-reader announcements for active/warning steps even when the card is folded. */}
      {announcedSteps.map((step) => (
        <span key={step.key} role="status" aria-live="polite" className="sr-only">
          {step.label}
        </span>
      ))}
    </div>
  );
}
