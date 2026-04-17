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
            // Button keeps consistent hit-area; the pill lives on the inner
            // span so the background tint hugs just the text, not the full
            // 32px button chrome.
            "flex h-8 items-center rounded-lg px-1.5",
            "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
            "hover:bg-accent",
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
                // Fixed width accommodates the widest label (X-High) so the
                // indicator doesn't jump between levels.
                "inline-block w-10 text-center",
                // X-High: tiny gold-tinted pill hugging the text only. Other
                // levels render as plain muted text with no background.
                isXHigh
                  ? "text-accent-gold bg-accent-gold/8 rounded-md px-1 py-px"
                  : "text-muted-foreground"
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
