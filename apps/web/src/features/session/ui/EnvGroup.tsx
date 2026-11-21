/** The transcript's shared line for a local checkout or a cloud computer. */
import { useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, useReducedMotion } from "framer-motion";
import {
  ChevronRight,
  CircleCheck,
  Cloud,
  CloudOff,
  Laptop,
  Loader2,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { SetupLogDialog } from "@/features/workspace/ui/SetupLogDialog";
import type { useSetupActions } from "@/features/workspace/hooks/useSetupActions";
import type { StartWarning } from "@/features/workspace/lib/startState";
import { cn } from "@/shared/lib/utils";

export interface EnvLine {
  key: string;
  label: string;
  icon: "done" | "active" | "warning" | "error";
  warning?: StartWarning;
  actions?: ReturnType<typeof useSetupActions>;
}

const ICON = "size-3.5 shrink-0";
const ROW = "flex min-h-7.5 items-center gap-2 pointer-coarse:min-h-11";
const QUIET = "text-text-tertiary dark:text-text-secondary/80";
const TRIGGER = "control-interaction rounded-lg text-left focus-visible:ring-text-secondary";
// Keep the xs button's visible surface while filling its row's touch target.
const ACTION =
  "relative before:absolute before:inset-x-0 before:top-1/2 before:h-7.5 before:-translate-y-1/2 pointer-coarse:before:h-11";

/** Each warning owns its disclosure. Unmounting it on a retry closes just that warning. */
function WarningRow({
  line,
  warning,
  focusTitle,
}: {
  line: EnvLine;
  warning: StartWarning;
  focusTitle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { actions } = line;
  return (
    <>
      <div className={ROW}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className={cn(ROW, TRIGGER, QUIET, "hover:text-text-primary min-w-0")}
        >
          <TriangleAlert aria-hidden className={cn(ICON, "text-warning")} />
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">{line.label}</span>
            {warning.preview && (
              <>
                <span aria-hidden>·</span>
                <samp className="min-w-0 truncate font-mono text-sm">{warning.preview}</samp>
              </>
            )}
          </span>
          <ChevronRight aria-hidden className={cn("size-3 shrink-0", open && "rotate-90")} />
        </button>
        {actions && (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className={ACTION}
            disabled={actions.retrying}
            onClick={() => {
              focusTitle();
              actions.retry();
            }}
          >
            <RotateCcw aria-hidden className="size-3" /> Run again
          </Button>
        )}
      </div>
      <div id={id} hidden={!open} className="text-text-secondary ms-5.5 mb-1">
        <p className="text-base text-pretty wrap-anywhere select-text">{warning.message}</p>
        {warning.output && (
          <pre className="bg-bg-raised mt-1.5 rounded-sm px-2.5 py-1.5 font-mono text-sm wrap-anywhere whitespace-pre-wrap select-text">
            <samp className="font-mono">{warning.output}</samp>
          </pre>
        )}
        {actions && (
          <div className={cn(ROW, "mt-0.5")}>
            <SetupLogDialog workspaceId={actions.workspaceId}>
              <Button type="button" size="xs" variant="ghost" className={cn(ACTION, "ps-0")}>
                View log
              </Button>
            </SetupLogDialog>
          </div>
        )}
      </div>
    </>
  );
}

interface EnvGroupProps {
  title: string;
  where: "local" | "cloud";
  state: "running" | "ready" | "asleep" | "failed";
  steps?: EnvLine[];
  /** A failed start's details, Retry and Delete, inside its steps card. */
  footer?: ReactNode;
}

export function EnvGroup({ title, where, state, steps = [], footer }: EnvGroupProps) {
  const [openedRun, setOpenedRun] = useState<string>();
  const titleButton = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const cardId = useId();
  const live = steps.filter(
    (line) => state === "ready" && (line.warning || line.icon === "active")
  );
  const history = steps.filter((line) => !live.includes(line));
  const run = steps[0]?.key;
  const hasCard = history.length > 0 || !!footer;
  const foldable = hasCard && state !== "running" && state !== "failed";
  const open = hasCard && (!foldable || (run !== undefined && openedRun === run));
  const Icon =
    state === "failed"
      ? TriangleAlert
      : state === "asleep"
        ? CloudOff
        : where === "cloud"
          ? Cloud
          : Laptop;

  const renderStep = (line: EnvLine) => {
    const Mark =
      line.icon === "done" ? CircleCheck : line.icon === "active" ? Loader2 : TriangleAlert;
    const announce = line.icon === "active" || line.icon === "warning";
    return (
      <div key={line.key} data-env-step={line.key}>
        {/* The same live node changes from failed to running even as its controls unmount. */}
        {announce && (
          <span role="status" aria-live="polite" className="sr-only">
            {line.label}
          </span>
        )}
        {line.warning ? (
          <WarningRow
            line={line}
            warning={line.warning}
            focusTitle={() => titleButton.current?.focus({ preventScroll: true })}
          />
        ) : (
          <div
            role={line.icon === "error" ? "alert" : undefined}
            className={cn(
              "flex items-center gap-2",
              line.icon === "error" && "text-destructive/80",
              line.icon === "done" && "text-text-tertiary",
              line.icon === "active" && "text-text-secondary",
              live.includes(line) && [ROW, QUIET]
            )}
          >
            <Mark
              aria-hidden
              className={cn(
                ICON,
                line.icon === "done" && "text-text-muted",
                line.icon === "active" && "animate-spin motion-reduce:animate-none",
                line.icon === "warning" && "text-warning"
              )}
            />
            <span aria-hidden={announce || undefined} className="min-w-0">
              {line.label}
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    // The transcript is itself a polite log. Only the status labels below should announce.
    <div data-slot="env-group" aria-live="off" className="flex w-full min-w-0 flex-col text-sm">
      <button
        type="button"
        ref={titleButton}
        disabled={!foldable}
        aria-label={title}
        aria-expanded={foldable ? open : undefined}
        aria-controls={foldable && open ? cardId : undefined}
        onClick={() => setOpenedRun(open ? undefined : run)}
        className={cn(
          ROW,
          "focus-visible:ring-ring w-fit max-w-full rounded-lg px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:outline-none",
          foldable ? "cursor-pointer" : state !== "ready" && "opacity-80"
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
            state === "running" && [
              "text-muted-foreground",
              !reduceMotion && "tool-loading-shimmer",
            ],
            state === "failed" && "text-destructive/80"
          )}
        >
          {title}
        </span>
        {foldable && (
          <ChevronRight
            aria-hidden
            className={cn("text-text-tertiary size-3 shrink-0", open && "rotate-90")}
          />
        )}
      </button>
      {live.length > 0 && <div className="mx-2 max-w-xl">{live.map(renderStep)}</div>}
      <AnimatePresence initial={false}>
        {open && (
          <Collapse id={cardId}>
            <div className="inset-ring-border-subtle mt-0.5 mb-1 flex max-w-xl flex-col gap-1.5 rounded-lg px-2 py-2.5 inset-ring">
              {history.map(renderStep)}
              {footer}
            </div>
          </Collapse>
        )}
      </AnimatePresence>
    </div>
  );
}
