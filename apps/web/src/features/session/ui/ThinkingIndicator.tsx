/**
 * ThinkingIndicator — text label that cycles thinking effort on click.
 *
 * No icon, no pips — just the word. Click cycles through model-specific levels:
 *   Claude (default):  Low → Med → High → Low
 *   Opus 4.7:          Low → Med → High → X-High → Low
 *   Codex:             Low → Med → High → Low
 *
 * Thinking level cycle is defined per-model in shared/agents/catalog. The
 * component itself is agent-agnostic. Visual weight increases with level via
 * font-weight + opacity, so the word communicates intensity at a glance.
 * X-High gets a tinted gold pill to signal the top gear.
 */

import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ThinkingLevel } from "@/shared/agents";

/** Display label for each level */
const LEVEL_DISPLAY: Record<ThinkingLevel, string> = {
  NONE: "Low",
  LOW: "Low",
  MEDIUM: "Med",
  HIGH: "High",
  XHIGH: "X-High",
};

/** Visual treatment per level — font weight and opacity */
const LEVEL_STYLE: Record<ThinkingLevel, { weight: number; opacity: number }> = {
  NONE: { weight: 400, opacity: 0.4 },
  LOW: { weight: 400, opacity: 0.6 },
  MEDIUM: { weight: 500, opacity: 0.75 },
  HIGH: { weight: 600, opacity: 0.9 },
  XHIGH: { weight: 700, opacity: 1 },
};

interface ThinkingIndicatorProps {
  level: ThinkingLevel;
  onClick: () => void;
  className?: string;
}

export function ThinkingIndicator({ level, onClick, className }: ThinkingIndicatorProps) {
  const style = LEVEL_STYLE[level];
  const displayLabel = LEVEL_DISPLAY[level];
  const isXHigh = level === "XHIGH";

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={`Thinking: ${displayLabel}`}
          className={cn(
            // Button keeps a click hit-area; the pill (background) lives on
            // the inner span so the tint hugs just the text. `group` lets the
            // span react to hover anywhere inside the button's hit area, so
            // the pill highlights even when the cursor is on button padding.
            // Minimal horizontal padding pulls the indicator tight against the
            // model picker (now that the pill is small).
            "group flex h-8 items-center rounded-lg px-0.5",
            "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
            className
          )}
        >
          <AnimatePresence mode="wait">
            <motion.span
              key={level}
              initial={{ opacity: 0, scaleX: 0.88 }}
              animate={{ opacity: style.opacity, scaleX: 1 }}
              exit={{ opacity: 0, scaleX: 0.88 }}
              transition={{ duration: 0.12, ease: [0.165, 0.84, 0.44, 1] }}
              style={{
                fontWeight: style.weight,
                originX: 0.5,
              }}
              className={cn(
                "text-xs transition-colors duration-200 select-none",
                // Fixed width accommodates the widest label ("X-High") + pill
                // padding. whitespace-nowrap guards against wrap on compact
                // themes. Always shaped as a pill so the hover and the X-High
                // "top gear" states share the same silhouette.
                "inline-block w-14 rounded-md px-1 py-px text-center whitespace-nowrap",
                // X-High: persistent gold-tinted pill signals the top gear.
                // Other levels render flat and only show the pill on hover.
                isXHigh
                  ? "text-accent-gold bg-accent-gold/8 group-hover:bg-accent-gold/12"
                  : "text-muted-foreground group-hover:bg-accent"
              )}
            >
              {displayLabel}
            </motion.span>
          </AnimatePresence>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Thinking level</TooltipContent>
    </Tooltip>
  );
}
