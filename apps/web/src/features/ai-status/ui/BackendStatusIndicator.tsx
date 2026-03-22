/**
 * BackendStatusIndicator — shows a red dot + label when the backend WebSocket is disconnected.
 * Renders nothing when connected (absence = healthy), same pattern as AIStatusIndicator.
 */

import { useState, useEffect } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { isConnected, onConnectionChange } from "@/platform/ws";

const EASE_OUT_QUART = [0.165, 0.84, 0.44, 1] as const;

export function BackendStatusIndicator() {
  const [connected, setConnected] = useState(isConnected());
  const reduceMotion = useReducedMotion();

  useEffect(() => onConnectionChange(setConnected), []);

  return (
    <AnimatePresence>
      {!connected && (
        <m.div
          key="backend-status"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE_OUT_QUART }}
          className="flex items-center gap-1.5 px-1 py-0.5"
          aria-label="Server disconnected"
        >
          <span className="relative flex h-2 w-2 items-center justify-center">
            <span className="bg-accent-red absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
            <span className="bg-accent-red relative inline-flex h-2 w-2 rounded-full" />
          </span>
          <span className="text-text-muted text-xs">Server disconnected</span>
        </m.div>
      )}
    </AnimatePresence>
  );
}
