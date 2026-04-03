/**
 * AIStatusIndicator — ambient AI provider health indicator for the sidebar footer.
 *
 * Renders nothing when all providers are operational (absence = healthy).
 * Shows a colored dot + label when any provider has issues.
 * Click opens a popover with per-provider breakdown + links to status pages.
 */

import { useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/shared/lib/utils";
import { EASE_OUT_QUART } from "@/shared/lib/animation";
import { useProviderStatuses, type ProviderStatusEntry } from "../api/ai-status.queries";
import { PROVIDER_REGISTRY, getIndicatorVisuals } from "../lib/providers";

export function AIStatusIndicator() {
  const { statuses, worst } = useProviderStatuses();
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  const visuals = worst ? getIndicatorVisuals(worst.indicator) : null;

  // AnimatePresence must stay mounted for exit animations to fire
  return (
    <AnimatePresence>
      {worst && visuals && (
        <m.div
          key="ai-status"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE_OUT_QUART }}
        >
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`AI provider status: ${visuals.label}`}
                className="hover:bg-bg-muted flex items-center gap-1.5 rounded-lg px-1 py-0.5 transition-colors duration-150"
              >
                <StatusPulse dotClass={visuals.dotClass} pulse={worst.indicator === "critical"} />
                <span className="text-text-muted text-xs">{visuals.label}</span>
              </button>
            </PopoverTrigger>

            <PopoverContent side="top" align="end" className="w-72 p-3">
              <StatusPopover statuses={statuses} />
            </PopoverContent>
          </Popover>
        </m.div>
      )}
    </AnimatePresence>
  );
}

function StatusPulse({ dotClass, pulse }: { dotClass: string; pulse: boolean }) {
  return (
    <span className="relative flex h-2 w-2 items-center justify-center">
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            dotClass
          )}
        />
      )}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", dotClass)} />
    </span>
  );
}

function StatusPopover({ statuses }: { statuses: ProviderStatusEntry[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-text-secondary text-xs font-medium">Provider Status</p>
      {statuses.map((s) => {
        const config = PROVIDER_REGISTRY[s.providerId];
        if (!config) return null;
        const visuals = getIndicatorVisuals(s.indicator);

        return (
          <div key={s.providerId} className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  s.isError ? "bg-text-muted" : visuals.dotClass
                )}
              />
              <span className="text-text-primary truncate text-sm">{config.name}</span>
            </div>
            <a
              href={config.statusPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted hover:text-text-secondary flex shrink-0 items-center gap-1 text-xs transition-colors duration-150"
            >
              {s.isError ? "Unavailable" : visuals.label}
              <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
        );
      })}
    </div>
  );
}
