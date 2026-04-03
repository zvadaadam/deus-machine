/**
 * ConnectionOrb — ambient connection health indicator for the sidebar footer.
 *
 * Always renders (unlike the old BackendStatusIndicator which only showed when disconnected).
 * Visual states:
 *   connected    → green dot, static
 *   grace_period → green dot (unchanged — 2s buffer, user sees nothing)
 *   reconnecting → amber dot with breathing pulse
 *   disconnected → amber dot with breathing pulse + "Offline" label
 */

import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { match } from "ts-pattern";
import { cn } from "@/shared/lib/utils";
import { EASE_OUT_QUART } from "@/shared/lib/animation";
import { useConnectionState, type ConnectionState } from "../hooks/useConnectionState";

function getAriaLabel(state: ConnectionState): string {
  return match(state)
    .with("connected", "grace_period", () => "Connected")
    .with("reconnecting", () => "Reconnecting")
    .with("disconnected", () => "Server disconnected")
    .exhaustive();
}

export function ConnectionOrb() {
  const { state } = useConnectionState();
  const reduceMotion = useReducedMotion();

  const isAmber = state === "reconnecting" || state === "disconnected";
  const showLabel = state === "disconnected";
  const showPulse = isAmber && !reduceMotion;

  return (
    <div
      className="flex items-center gap-1.5 px-1 py-0.5"
      role="status"
      aria-label={getAriaLabel(state)}
    >
      <span className="relative flex h-2 w-2 items-center justify-center">
        {/* Breathing pulse ring */}
        {showPulse && (
          <span className="bg-accent-gold absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
        )}
        {/* Solid dot — CSS transition for color (compositor-friendly) */}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full transition-colors duration-300",
            isAmber ? "bg-accent-gold" : "bg-accent-green"
          )}
        />
      </span>

      {/* "Offline" label — only in disconnected state */}
      <AnimatePresence>
        {showLabel && (
          <m.span
            key="connection-label"
            className="text-text-muted overflow-hidden text-xs whitespace-nowrap"
            initial={reduceMotion ? false : { opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -4 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE_OUT_QUART }}
          >
            Offline
          </m.span>
        )}
      </AnimatePresence>
    </div>
  );
}
