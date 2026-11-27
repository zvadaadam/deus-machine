import type { ReactNode } from "react";
import { m } from "framer-motion";
import { tempo } from "@/shared/lib/tempo";
import { cn } from "@/shared/lib/utils";

const surface =
  "bg-bg-muted dark:bg-bg-surface border-border-strong overflow-hidden rounded-t-2xl border";
const tint = "bg-control-hover";

export function ComposerTray({ children }: { children: ReactNode }) {
  return (
    <m.div
      className={cn(surface, "absolute inset-x-2 bottom-full -mb-4")}
      onMouseDown={(event) => event.preventDefault()}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4, transition: tempo.fast.exit }}
      transition={tempo.fast}
    >
      <div className={cn(tint, "box-content flex max-h-[min(320px,40dvh)] flex-col pb-4")}>
        {children}
      </div>
    </m.div>
  );
}

export function QueueTray({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="relative isolate mx-2">
      {open && (
        <div
          aria-hidden="true"
          className={cn(surface, "pointer-events-none absolute inset-x-0 top-0 -bottom-4 -z-10")}
        >
          <div className={cn(tint, "size-full")} />
        </div>
      )}
      <div
        role="group"
        aria-label="Queued messages"
        {...(!open && { inert: "" })}
        className="isolate max-h-[min(12rem,25dvh)] overflow-y-auto px-2 pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11"
      >
        {children}
      </div>
    </div>
  );
}
