/**
 * The environment line in a transcript: what was set up for this chat to run
 * in, read like a tool row. While it runs, a shimmering title over a card of
 * the steps reached so far; once it settles fine, one quiet line whose steps
 * open on a click; when it fails, the title says so and the card stays open
 * with the reason and the ways out (`footer`). Warnings sit under the line,
 * always in view.
 *
 * Cloud provisioning (CloudEnvProgress) and a local workspace's start
 * (WorkspaceStartGroup) both render through it, so the two read alike.
 */
import { useState, type ReactNode } from "react";
import { AnimatePresence, m } from "framer-motion";
import {
  ChevronRight,
  CircleCheck,
  Cloud,
  CloudOff,
  Laptop,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";

export interface EnvLine {
  key: string;
  label: string;
  icon: "done" | "active" | "warning" | "error";
}

const ICON = "h-3.5 w-3.5 flex-shrink-0";

function StepRow({ line }: { line: EnvLine }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        line.icon === "done" && "text-text-tertiary",
        line.icon === "active" && "text-text-secondary",
        line.icon === "warning" && "text-warning",
        line.icon === "error" && "text-destructive/80"
      )}
      role={line.icon === "error" ? "alert" : undefined}
    >
      {line.icon === "done" && <CircleCheck className={cn(ICON, "text-text-muted")} />}
      {line.icon === "active" && (
        <Loader2 className={cn(ICON, "animate-spin motion-reduce:animate-none")} />
      )}
      {(line.icon === "warning" || line.icon === "error") && <TriangleAlert className={ICON} />}
      <span className="min-w-0">{line.label}</span>
    </div>
  );
}

interface EnvGroupProps {
  title: string;
  /** Where it runs: the title's icon. */
  where: "local" | "cloud";
  state: "running" | "ready" | "asleep" | "failed";
  /** The steps reached so far, in the card. */
  steps?: EnvLine[];
  /** A short note after the title, e.g. "1 warning". */
  note?: string;
  /** Under the steps, inside the card: a failure's ways out. */
  footer?: ReactNode;
  warnings?: string[];
}

export function EnvGroup({
  title,
  where,
  state,
  steps = [],
  note,
  footer,
  warnings = [],
}: EnvGroupProps) {
  // A failure and its ways out are never folded away. Otherwise the person's
  // own click wins, and without one it is open while it runs.
  const [pinned, setPinned] = useState<boolean | null>(null);
  const hasCard = steps.length > 0 || !!footer;
  const foldable = hasCard && state !== "failed";
  const open = hasCard && (!foldable || (pinned ?? state === "running"));
  const Icon =
    state === "failed"
      ? TriangleAlert
      : state === "asleep"
        ? CloudOff
        : where === "cloud"
          ? Cloud
          : Laptop;

  return (
    <div className="flex w-full min-w-0 flex-col text-sm" role="status" aria-live="polite">
      <button
        type="button"
        onClick={() => setPinned(!open)}
        disabled={!foldable}
        aria-expanded={foldable ? open : undefined}
        className={cn(
          "group flex w-full items-center gap-2 px-2 py-1.5 text-left opacity-80",
          foldable && "cursor-pointer transition-opacity duration-150 hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        <span className="relative h-3.5 w-3.5 flex-shrink-0">
          <Icon
            className={cn(
              "absolute top-0 left-0 h-3.5 w-3.5 transition-opacity duration-150 ease-out",
              state === "failed" ? "text-destructive/80" : "text-muted-foreground",
              foldable && (pinned ? "opacity-0" : "group-hover:opacity-0")
            )}
            aria-hidden="true"
          />
          {foldable && (
            <ChevronRight
              className={cn(
                "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out",
                open && "rotate-90",
                pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              aria-hidden="true"
            />
          )}
        </span>
        <span
          className={cn(
            "font-medium",
            state === "running" && "text-muted-foreground tool-loading-shimmer",
            state === "failed" && "text-destructive/80",
            (state === "ready" || state === "asleep") && "text-foreground/70"
          )}
        >
          {title}
        </span>
        {note && <span className="text-warning">· {note}</span>}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.215, 0.61, 0.355, 1] }}
            className="overflow-hidden"
          >
            <div className="border-border-subtle mx-2 mt-0.5 mb-1 flex max-w-xl flex-col gap-1.5 rounded-lg border px-3 py-2.5">
              {steps.map((line) => (
                <StepRow key={line.key} line={line} />
              ))}
              {footer}
            </div>
          </m.div>
        )}
      </AnimatePresence>

      {warnings.length > 0 && (
        <div className="flex flex-col gap-1.5 px-2 pt-1 pb-1">
          {warnings.map((warning) => (
            <div
              key={warning}
              className="border-warning/20 border-l-warning bg-warning/5 text-warning max-w-xl rounded-lg border border-l-2 px-3 py-2"
            >
              {warning}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
