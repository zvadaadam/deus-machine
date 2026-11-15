/**
 * The environment line in a transcript: what was set up for this chat to run
 * in. One collapsed line that is the live truth (the active step spinning,
 * then "ready"), a chevron that opens the steps behind it, and under it,
 * always in view, whatever the reader has to know: a warning, or the failure
 * and the ways out of it.
 *
 * Cloud provisioning (CloudEnvProgress) and a local workspace's start
 * (WorkspaceStartGroup) both render through it, so the two read alike.
 */
import { useState, type ReactNode } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Check, ChevronRight, CloudOff, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export interface EnvLine {
  key: string;
  label: string;
  icon: "done" | "active" | "asleep" | "warning" | "error";
  tone?: "ready" | "muted" | "warning" | "error";
}

function LineIcon({ icon }: { icon: EnvLine["icon"] }) {
  switch (icon) {
    case "active":
      return (
        <Loader2 className="text-text-muted h-3 w-3 flex-shrink-0 animate-spin motion-reduce:animate-none" />
      );
    case "done":
      return <Check className="text-accent-green h-3 w-3 flex-shrink-0" />;
    case "asleep":
      return <CloudOff className="text-text-disabled h-3 w-3 flex-shrink-0" />;
    case "warning":
      return <TriangleAlert className="text-warning/80 h-3 w-3 flex-shrink-0" />;
    case "error":
      return <TriangleAlert className="text-destructive/80 h-3 w-3 flex-shrink-0" />;
  }
}

function lineTextClass(tone: EnvLine["tone"]): string {
  return cn(
    "font-mono text-xs tracking-tight",
    tone === "error"
      ? "text-destructive/80"
      : tone === "warning"
        ? "text-warning"
        : tone === "ready"
          ? "text-text-secondary"
          : "text-text-muted"
  );
}

interface EnvGroupProps {
  /** The line that stays in view. */
  summary: EnvLine;
  /** The steps behind it, shown when opened. */
  detail?: EnvLine[];
  /** A short note after the summary, e.g. "1 warning". */
  note?: string;
  /** Warnings and failures: boxes under the line, never folded away. */
  children?: ReactNode;
}

export function EnvGroup({ summary, detail = [], note, children }: EnvGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = detail.length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col" role="status" aria-live="polite">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded(!expanded)}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? expanded : undefined}
        className={cn(
          "group flex w-full items-center gap-2 px-2 py-1 text-left",
          hasDetail && "cursor-pointer",
          "transition-opacity duration-150 ease-out",
          hasDetail && "opacity-90 hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        <div className="relative h-3 w-3 flex-shrink-0">
          <div
            className={cn(
              "absolute top-0 left-0 transition-opacity duration-150 ease-out",
              hasDetail && (expanded ? "opacity-0" : "opacity-100 group-hover:opacity-0")
            )}
          >
            <LineIcon icon={summary.icon} />
          </div>
          {hasDetail && (
            <ChevronRight
              className={cn(
                "text-muted-foreground/50 absolute top-0 left-0 h-3 w-3 transition-[transform,opacity] duration-150 ease-out",
                expanded && "rotate-90",
                expanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              aria-hidden="true"
            />
          )}
        </div>
        <span className={lineTextClass(summary.tone)}>{summary.label}</span>
        {note && <span className="text-warning font-mono text-xs tracking-tight">· {note}</span>}
        {hasDetail && (
          <span className="text-muted-foreground/40 font-mono text-xs" aria-hidden="true">
            · {detail.length} {detail.length === 1 ? "step" : "steps"}
          </span>
        )}
      </button>

      <AnimatePresence>
        {expanded && hasDetail && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.215, 0.61, 0.355, 1] }}
            className="flex flex-col overflow-hidden"
          >
            {detail.map((line) => (
              <div key={line.key} className="flex items-center gap-2 px-2 py-0.5 pl-7">
                <LineIcon icon={line.icon} />
                <span className={lineTextClass(line.tone)}>{line.label}</span>
              </div>
            ))}
          </m.div>
        )}
      </AnimatePresence>

      {children && <div className="flex flex-col gap-1.5 px-2 pt-1 pb-1">{children}</div>}
    </div>
  );
}

/** A warning or a failure under an environment line. */
export function EnvNotice({ tone, children }: { tone: "warning" | "error"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "max-w-xl rounded-lg border border-l-2 px-3 py-2 text-sm",
        tone === "warning"
          ? "border-warning/20 border-l-warning bg-warning/5 text-warning"
          : "border-destructive/20 border-l-destructive bg-destructive/5 text-text-secondary"
      )}
    >
      {children}
    </div>
  );
}
