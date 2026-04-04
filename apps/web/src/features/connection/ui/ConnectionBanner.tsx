/**
 * ConnectionBanner — top-of-content-area bar for connection issues.
 *
 * Two stages:
 *   RECONNECTING (2-30s): "Reconnecting..." with amber accent
 *   DISCONNECTED (30s+):  "Connection lost" + Retry button
 *
 * Fixed 40px height — only animates transform + opacity (GPU-composited).
 * Content cross-fades between stages via AnimatePresence.
 */

import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { EASE_OUT_QUART } from "@/shared/lib/animation";
import { useConnectionState } from "../hooks/useConnectionState";

export function ConnectionBanner() {
  const { state, sendAttemptFailed, retry } = useConnectionState();
  const reduceMotion = useReducedMotion();

  const showBanner = state === "reconnecting" || state === "disconnected";
  const isEscalated = state === "disconnected";

  return (
    <AnimatePresence>
      {showBanner && (
        <m.div
          key="connection-banner"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="relative w-full overflow-hidden"
          style={{ height: 40 }}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -40 }}
          transition={{
            duration: reduceMotion ? 0.1 : 0.25,
            ease: EASE_OUT_QUART,
          }}
        >
          {/* Amber bottom accent line */}
          <div className="bg-accent-gold/30 absolute bottom-0 left-0 h-[2px] w-full" />

          <div className="flex h-full items-center justify-between px-4">
            <div className="flex items-center gap-2.5">
              {/* Amber dot — suppress ping animation for reduced motion */}
              <span className="relative flex h-1.5 w-1.5">
                {!reduceMotion && (
                  <span className="bg-accent-gold absolute inline-flex h-full w-full animate-ping rounded-full opacity-40" />
                )}
                <span className="bg-accent-gold relative inline-flex h-1.5 w-1.5 rounded-full" />
              </span>

              {/* Copy — cross-fades between reconnecting and disconnected */}
              <AnimatePresence mode="wait">
                {isEscalated ? (
                  <m.div
                    key="disconnected-copy"
                    className="flex items-baseline gap-1.5"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.15 }}
                  >
                    <span className="text-text-secondary text-sm font-medium">
                      {sendAttemptFailed ? "Message queued" : "Connection lost"}
                    </span>
                    <span className="text-text-muted text-xs">
                      {sendAttemptFailed ? "— reconnecting" : "— Your agents are still running"}
                    </span>
                  </m.div>
                ) : (
                  <m.span
                    key="reconnecting-copy"
                    className="text-text-muted text-sm"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.15 }}
                  >
                    Reconnecting...
                  </m.span>
                )}
              </AnimatePresence>
            </div>

            {/* Retry button — only in escalated state */}
            <AnimatePresence>
              {isEscalated && (
                <m.button
                  key="retry-btn"
                  type="button"
                  onClick={retry}
                  className="text-accent-gold hover:text-accent-gold/80 text-xs font-medium transition-colors duration-150"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.2 }}
                >
                  Retry now
                </m.button>
              )}
            </AnimatePresence>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
