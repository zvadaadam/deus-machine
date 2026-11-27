import type { ReactNode } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { tempo } from "@/shared/lib/tempo";
import { cn } from "@/shared/lib/utils";

const surface =
  "bg-bg-muted dark:bg-bg-surface border-border-strong overflow-hidden rounded-t-2xl border";
const tint = "bg-control-hover";

export function ComposerTray({ children }: { children: ReactNode }) {
  const rise = useReducedMotion() ? 0 : 4;
  // The queue sets the first grid row's height. Both trays tuck another rem under the input.
  return (
    <m.div
      className={cn(
        surface,
        "absolute inset-x-2 bottom-0 row-[1/2] -mb-4 flex min-h-[calc(100%+1rem)] flex-col"
      )}
      onMouseDown={(event) => event.preventDefault()}
      initial={{ opacity: 0, y: rise }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: rise, transition: tempo.fast.exit }}
      transition={tempo.fast}
    >
      <div
        className={cn(tint, "box-content flex max-h-(--tray-cap) grow flex-col justify-end pb-4")}
      >
        {children}
      </div>
    </m.div>
  );
}

export function QueueTray({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="relative isolate row-start-1 mx-2">
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            aria-hidden="true"
            className={cn(surface, "pointer-events-none absolute inset-x-0 top-0 -bottom-4 -z-10")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: tempo.moderate.exit }}
            transition={tempo.moderate}
          >
            <div className={cn(tint, "size-full")} />
          </m.div>
        )}
      </AnimatePresence>
      <div
        role="group"
        aria-label="Queued messages"
        {...(!open && { inert: "" })}
        className="isolate max-h-[min(12rem,25dvh,var(--tray-cap))] overflow-y-auto px-2 pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11"
      >
        {children}
      </div>
    </div>
  );
}
